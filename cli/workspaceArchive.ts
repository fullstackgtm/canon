/**
 * A workspace archive (docs/self-hosting.md, "Export a workspace"): a tar holding `manifest.json`,
 * `sections/<name>/<n>.ndjson.gz` parts of about 8 MB of NDJSON each, and `files/<storage id>`, the bytes of every
 * stored file the rows name (at most FILE_MAX_BYTES each and FILES_MAX_BYTES in all). `exportWorkspace` reads a deployment through
 * its export route and writes one; `readArchive` and `verifyArchive` check one against its manifest, and the import
 * will read archives with them.
 *
 * Node built-ins only.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

export const FORMAT_VERSION = 1;
const PART_BYTES = 8 * 1024 * 1024;
/**
 * The most file bytes one archive carries, and one file. `canon workspace import` reads an archive into memory, and
 * sends each file to the importing deployment in one Convex action call, whose arguments are at most 16 MiB (the
 * file goes as base64). A module field takes 10 MB unless it says more (modules/kernel/schema.ts). Past either
 * limit, the export stops and says which files.
 */
export const FILES_MAX_BYTES = 1024 * 1024 * 1024;
export const FILE_MAX_BYTES = 10 * 1024 * 1024;

export type Part = { file: string; sha256: string; rows: number };
export type SectionManifest = { count: number; parts: Part[]; storageRefs: number; embeddedIds: Record<string, number> };
/** A stored file the archive carries, at `files/<its source storage id>`. */
export type FileEntry = { file: string; sha256: string; bytes: number; contentType: string };
export type Manifest = {
  formatVersion: number;
  source: { kind: "selfhost" | "hosted"; appCommit: string | null; dataEpoch: number; minEpoch: number; recordContract: string | null };
  workspace: { id: string; name: string; slug: string };
  exportedAt: string;
  exportedBy: string;
  sections: Record<string, SectionManifest>;
  /** The stored files rows name, by their storage id in the source. Absent in archives from before files moved. */
  files?: Record<string, FileEntry>;
  notExported: { table: string; class: string; why?: string; count?: number; atLeast?: number }[];
  notes: string[];
};

type Stats = { rows: number; storageRefs: number; embedded: Record<string, number> };
type PageResult = { count: number; rows?: string[]; ids?: string[]; cursor: string | null; pending: string[]; rest: string[]; stats?: Stats };
type Plan = {
  workspace: Manifest["workspace"]; exportedBy: string; sourceKind: "selfhost" | "hosted";
  sections: { name: string; parent?: string }[]; registerSections: string[]; notExported: Manifest["notExported"];
  source: { appCommit: string | null; dataEpoch: number; minEpoch: number };
};
type RegisterInfo = { mode: "service" | "convex"; contract: string | null; counts: Record<string, number> | null };

/** The export route's operations (src/app/api/v1/workspace/export/route.ts). */
export type Transport = {
  plan(): Promise<Plan>;
  page(args: { section: string; cursor?: string | null; numItems?: number; parents?: string[]; parentId?: string; countOnly?: boolean }): Promise<PageResult>;
  registerInfo(): Promise<RegisterInfo>;
  register(args: { section: string; after?: string; limit?: number }): Promise<{ count: number; rows: string[]; next: string | null; stats: Stats }>;
  /** The stored files of these rows, each with a download link (convex/workspaceTransfer.ts exportFiles). */
  files(args: { rows: Array<{ section: string; id: string }> }): Promise<{ files: Array<{ id: string; bytes: number; contentType: string; url: string }> }>;
  download(url: string): Promise<Uint8Array>;
};

/** Where archive files go, in order. */
export type Sink = { add(path: string, bytes: Uint8Array): void };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Batches lines into gzipped parts of about PART_BYTES each. */
class SectionWriter {
  private lines: string[] = [];
  private bytes = 0;
  readonly manifest: SectionManifest = { count: 0, parts: [], storageRefs: 0, embeddedIds: {} };
  private readonly name: string;
  private readonly sink: Sink;
  constructor(name: string, sink: Sink) {
    this.name = name;
    this.sink = sink;
  }
  add(lines: string[], stats?: Stats) {
    for (const line of lines) {
      this.lines.push(line);
      this.bytes += line.length + 1;
      if (this.bytes >= PART_BYTES) this.flush();
    }
    this.manifest.count += lines.length;
    if (!stats) return;
    this.manifest.storageRefs += stats.storageRefs;
    for (const [k, n] of Object.entries(stats.embedded)) this.manifest.embeddedIds[k] = (this.manifest.embeddedIds[k] ?? 0) + n;
  }
  flush() {
    if (!this.lines.length) return;
    const file = `sections/${this.name}/${this.manifest.parts.length + 1}.ndjson.gz`;
    const gz = gzipSync(Buffer.from(this.lines.map((l) => `${l}\n`).join(""), "utf8"));
    this.sink.add(file, gz);
    this.manifest.parts.push({ file, sha256: sha256(gz), rows: this.lines.length });
    this.lines = [];
    this.bytes = 0;
  }
}

/** An error the server answered on purpose (a refused key, a bad request): asking again with a smaller page won't help. */
export class ExportRefused extends Error {}

/** A failed page is most often one too big for a query's read limits, whose message production redacts: halve it and ask again. */
async function shrinking<T>(numItems: number, read: (n: number) => Promise<T>): Promise<{ result: T; numItems: number }> {
  for (let n = numItems; ; n = Math.floor(n / 2)) {
    try {
      return { result: await read(n), numItems: n };
    } catch (error) {
      if (n <= 1 || error instanceof ExportRefused) throw error;
    }
  }
}

/** The export route of the deployment at `base`, authenticated with an export key. */
export function httpTransport(base: string, key: string, fetchImpl: typeof fetch = fetch): Transport {
  const call = async (body: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/v1/workspace/export`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      throw new ExportRefused(`Could not reach ${base} (${error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.message : String(error)}). Check --url or CANON_URL.`);
    }
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (response.ok && payload) return payload;
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 404 && !payload) throw new ExportRefused(`${base} has no workspace export route (HTTP 404). Update the deployment, or check --url.`);
    throw response.status < 500 ? new ExportRefused(message) : new Error(message);
  };
  return {
    plan: () => call({ op: "plan" }) as Promise<Plan>,
    page: (args) => call({ op: "page", ...args }) as Promise<PageResult>,
    registerInfo: () => call({ op: "registerInfo" }) as Promise<RegisterInfo>,
    register: (args) => call({ op: "register", ...args }) as Promise<{ count: number; rows: string[]; next: string | null; stats: Stats }>,
    files: (args) => call({ op: "files", ...args }) as Promise<{ files: Array<{ id: string; bytes: number; contentType: string; url: string }> }>,
    download: async (url) => {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`Downloading a stored file failed: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Every stored file the exported rows name, into `files/<id>`: asked for by row, so the deployment answers only files
 * of this workspace, then read one at a time. Stops before writing any when a file or the sum is over the ceiling.
 */
async function exportFiles(t: Transport, sink: Sink, rows: Array<{ section: string; id: string }>): Promise<Record<string, FileEntry>> {
  const found = new Map<string, { bytes: number; contentType: string; url: string }>();
  for (let i = 0; i < rows.length; i += 100) for (const f of (await t.files({ rows: rows.slice(i, i + 100) })).files) found.set(f.id, f);
  const total = [...found.values()].reduce((n, f) => n + f.bytes, 0);
  const big = [...found].filter(([, f]) => f.bytes > FILE_MAX_BYTES);
  if (big.length || total > FILES_MAX_BYTES) {
    const largest = [...found].sort(([, a], [, b]) => b.bytes - a.bytes).slice(0, 5).map(([id, f]) => `${id} (${mib(f.bytes)})`);
    throw new ExportRefused(`This workspace's files are too big for one archive: ${found.size} files, ${mib(total)} in all${big.length ? `, ${big.length} over ${mib(FILE_MAX_BYTES)} each` : ""}. An archive carries at most ${mib(FILES_MAX_BYTES)} of files and ${mib(FILE_MAX_BYTES)} per file. The largest: ${largest.join(", ")}.`);
  }
  const out: Record<string, FileEntry> = {};
  for (const [id, f] of found) {
    const bytes = await t.download(f.url);
    if (bytes.length !== f.bytes) throw new Error(`Stored file ${id} came back ${bytes.length} bytes, not ${f.bytes}. Run the export again.`);
    const file = `files/${id}`;
    sink.add(file, bytes);
    out[id] = { file, sha256: sha256(bytes), bytes: bytes.length, contentType: f.contentType };
  }
  return out;
}

/** Every row of every section, in parent-first order; parents' ids are kept only for sections read through them. */
async function eachSection(t: Transport, plan: Plan, onPage: (section: string, page: PageResult) => void, countOnly: boolean) {
  const parents = new Set(plan.sections.flatMap((s) => (s.parent ? [s.parent] : [])));
  const ids = new Map<string, string[]>();
  for (const section of plan.sections) {
    const keep = parents.has(section.name) ? (ids.set(section.name, []), ids.get(section.name)!) : null;
    const take = (page: PageResult) => {
      onPage(section.name, page);
      if (keep && page.ids) keep.push(...page.ids);
    };
    let numItems = 128;
    const pageThrough = async (args: { parentId?: string }) => {
      let cursor: string | null = null;
      do {
        const read = await shrinking(numItems, (n) => t.page({ section: section.name, cursor, numItems: n, ...args, countOnly: countOnly && !keep }));
        numItems = read.numItems;
        take(read.result);
        cursor = read.result.cursor;
      } while (cursor);
    };
    if (!section.parent) {
      await pageThrough({});
      continue;
    }
    const queue = [...(ids.get(section.parent) ?? [])];
    while (queue.length) {
      const batch = queue.splice(0, 50);
      const page = await t.page({ section: section.name, parents: batch, countOnly: countOnly && !keep });
      take(page);
      queue.unshift(...page.rest);
      for (const parentId of page.pending) await pageThrough({ parentId });
    }
  }
}

/** Export the workspace the transport's key names into `sink`, manifest last. */
export async function exportWorkspace(t: Transport, sink: Sink, now = new Date()): Promise<Manifest> {
  const plan = await t.plan();
  const info = await t.registerInfo();
  const writers = new Map<string, SectionWriter>();
  const writer = (name: string) => writers.get(name) ?? (writers.set(name, new SectionWriter(name, sink)), writers.get(name)!);
  // Rows that name a stored file, whose bytes go into the archive after the sections.
  const withFiles: Array<{ section: string; id: string }> = [];
  await eachSection(t, plan, (section, page) => {
    writer(section).add(page.rows ?? [], page.stats);
    (page.rows ?? []).forEach((line, i) => { if (line.includes('"$ref":"_storage"') && page.ids?.[i]) withFiles.push({ section, id: page.ids[i] }); });
  }, false);
  const notes = ["Stored files are in files/<id>; each section's storageRefs counts the files its rows name."];
  if (info.mode === "service") {
    for (const section of plan.registerSections) {
      let after: string | undefined;
      do {
        const page = await t.register({ section, ...(after !== undefined ? { after } : {}), limit: 1000 });
        writer(section).add(page.rows, page.stats);
        after = page.next ?? undefined;
      } while (after !== undefined);
    }
  } else {
    notes.push("This deployment keeps its register in Convex (no record service): it is in the fakeRecordAccounts, fakeRecordContacts and fakeRecordHistory sections.");
  }
  for (const w of writers.values()) w.flush();
  const files = await exportFiles(t, sink, withFiles);
  const sections: Record<string, SectionManifest> = {};
  for (const name of [...plan.sections.map((s) => s.name), ...(info.mode === "service" ? plan.registerSections : [])]) sections[name] = writer(name).manifest;
  const manifest: Manifest = {
    formatVersion: FORMAT_VERSION,
    source: { kind: plan.sourceKind, appCommit: plan.source.appCommit, dataEpoch: plan.source.dataEpoch, minEpoch: plan.source.minEpoch, recordContract: info.contract },
    workspace: plan.workspace,
    exportedAt: now.toISOString(),
    exportedBy: plan.exportedBy,
    sections,
    files,
    notExported: plan.notExported,
    notes,
  };
  sink.add("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  return manifest;
}

/** Each section's row count on the deployment now, read the way an export reads it. */
export async function liveCounts(t: Transport): Promise<Record<string, number>> {
  const plan = await t.plan();
  const counts: Record<string, number> = {};
  await eachSection(t, plan, (section, page) => { counts[section] = (counts[section] ?? 0) + page.count; }, true);
  const info = await t.registerInfo();
  if (info.counts) Object.assign(counts, info.counts);
  return counts;
}

// ---------- tar ----------

function tarHeader(path: string, size: number) {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(path) > 100) throw new Error(`archive path too long: ${path}`);
  h.write(path, 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** A sink that writes a tar file as files arrive. Call `close` once, after the last file. */
export function tarFileSink(path: string): Sink & { close(): void } {
  const fd = openSync(path, "wx", 0o600);
  return {
    add(name, bytes) {
      writeSync(fd, tarHeader(name, bytes.length));
      writeSync(fd, bytes);
      const pad = (512 - (bytes.length % 512)) % 512;
      if (pad) writeSync(fd, Buffer.alloc(pad));
    },
    close() {
      writeSync(fd, Buffer.alloc(1024));
      closeSync(fd);
    },
  };
}

/** Every file in a tar archive, read one header at a time. */
export function readArchive(path: string): Map<string, Buffer> {
  const fd = openSync(path, "r");
  const files = new Map<string, Buffer>();
  try {
    let offset = 0;
    const header = Buffer.alloc(512);
    for (;;) {
      if (readSync(fd, header, 0, 512, offset) < 512 || header.every((b) => b === 0)) break;
      const name = header.toString("utf8", 0, 100).replace(/\0[\s\S]*$/, "");
      const size = parseInt(header.toString("utf8", 124, 136).replace(/\0[\s\S]*$/, "").trim() || "0", 8);
      const body = Buffer.alloc(size);
      if (readSync(fd, body, 0, size, offset + 512) < size) throw new Error(`archive truncated in ${name}`);
      files.set(name, body);
      offset += 512 + size + ((512 - (size % 512)) % 512);
    }
  } finally {
    closeSync(fd);
  }
  return files;
}

export type SectionCheck = { section: string; manifest: number; archive: number; live?: number; problems: string[] };

/** Check every part's checksum and row count against the manifest, and with `live`, each section's count against it. */
export function verifyArchive(files: Map<string, Uint8Array>, live?: Record<string, number>): { manifest: Manifest; checks: SectionCheck[]; ok: boolean } {
  const raw = files.get("manifest.json");
  if (!raw) throw new Error("Not a Canon workspace archive: it has no manifest.json.");
  const manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as Manifest;
  if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`Archive format ${manifest.formatVersion} is not one this canon reads (${FORMAT_VERSION}).`);
  const listed = new Set<string>(["manifest.json"]);
  const checks: SectionCheck[] = [];
  for (const [section, s] of Object.entries(manifest.sections)) {
    const problems: string[] = [];
    let archive = 0;
    for (const part of s.parts) {
      listed.add(part.file);
      const bytes = files.get(part.file);
      if (!bytes) { problems.push(`${part.file} is missing`); continue; }
      if (sha256(bytes) !== part.sha256) { problems.push(`${part.file} checksum differs`); continue; }
      const text = gunzipSync(bytes).toString("utf8");
      const rows = text ? text.split("\n").filter(Boolean).length : 0;
      if (rows !== part.rows) problems.push(`${part.file} holds ${rows} rows, manifest says ${part.rows}`);
      archive += rows;
    }
    if (archive !== s.count && !problems.length) problems.push(`parts hold ${archive} rows, manifest says ${s.count}`);
    const check: SectionCheck = { section, manifest: s.count, archive, problems };
    if (live) {
      check.live = live[section] ?? 0;
      if (check.live !== s.count) problems.push(`the deployment has ${check.live} now`);
    }
    checks.push(check);
  }
  for (const [id, f] of Object.entries(manifest.files ?? {})) {
    listed.add(f.file);
    const bytes = files.get(f.file);
    const problems = f.file !== `files/${id}` ? ["not where the manifest's file id says"] : !bytes ? ["missing"] : sha256(bytes) !== f.sha256 ? ["checksum differs"] : [];
    if (problems.length) checks.push({ section: f.file, manifest: 1, archive: bytes ? 1 : 0, problems });
  }
  for (const name of files.keys()) if (!listed.has(name)) checks.push({ section: name, manifest: 0, archive: 0, problems: ["a file the manifest does not list"] });
  if (live) for (const section of Object.keys(live)) if (!(section in manifest.sections)) checks.push({ section, manifest: 0, archive: 0, live: live[section], problems: ["a section the deployment has and the archive lacks"] });
  return { manifest, checks, ok: checks.every((c) => !c.problems.length) };
}
