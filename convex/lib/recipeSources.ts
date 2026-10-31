/**
 * Where an installed recipe comes from (docs/recipes.md, "Distribution and trust"). A public GitHub repo is read
 * unauthenticated: a ref resolves to a commit through the API, and the package's files come from the raw host
 * at that commit. A private repo (R5b) is read through Canon's GitHub App: one installation token, scoped to that
 * repo, per operation, with the files from the API's contents endpoint at the pinned commit. Both pin the install
 * to a commit and share the size caps and timeouts. RECIPE_GITHUB_API_BASE and RECIPE_GITHUB_RAW_BASE point both at
 * a local fixture in tests and local checks. Actions only: it fetches.
 */
import { ConvexError } from "convex/values";
import { BUNDLE_FILE, BUNDLE_MAX_BYTES, LEGACY_FILES, RECIPE_FILE, RECIPE_MAX_BYTES } from "../../recipes/manifest.ts";
import { GithubAppError, apiBase, installationToken } from "./githubApp";

/** A repo, a directory in it and a ref, as the user wrote it. */
export type RepoRef = { owner: string; repo: string; path?: string; ref: string };
export type RecipeSource = RepoRef & ({ kind: "github-public" } | { kind: "github-app"; installationId: number });
export type PinnedSource = RecipeSource & { sha: string };
/** A GitHub account the workspace connected Canon's App to (githubRecipeConnections). */
export type Connection = { installationId: number; login: string; repos: readonly string[] };
/** Whether a connection may read owner/repo: its account owns it and the person who connected it could see it. */
const covers = (c: Connection, r: { owner: string; repo: string }) => sameLogin(c.login, r.owner) && c.repos.some((full) => sameLogin(full, `${r.owner}/${r.repo}`));

export const FETCH_TIMEOUT_MS = 10_000;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;
const SOURCE_FORMAT = "github:owner/repo[/path]@ref, like github:fullstackgtm/canon-recipes/velocity-deal@v1.0.0";

const refuse = (message: string): never => { throw new ConvexError(message); };
const segmentOk = (s: string) => NAME.test(s) && s !== "." && s !== "..";

export function checkRef(ref: string): string {
  return !REF.test(ref) || ref.includes("..") || ref.endsWith("/") ? refuse(`"${ref}" isn't a tag, branch or commit name.`) : ref;
}

/** `github:owner/repo[/path]@ref`, checked: every part a plain name, so none can climb out of the repo. */
export function parseSource(text: string): RepoRef {
  const m = /^(?:github:)?([^@\s]+)@(\S+)$/.exec(text.trim());
  if (!m) return refuse(`A customization source looks like ${SOURCE_FORMAT}.`);
  const [owner, repo, ...path] = m[1].split("/");
  if (!owner || !OWNER.test(owner) || !repo || !segmentOk(repo) || path.length > 10 || !path.every(segmentOk)) return refuse(`A customization source looks like ${SOURCE_FORMAT}.`);
  return { owner, repo, ...(path.length ? { path: path.join("/") } : {}), ref: checkRef(m[2]) };
}

export const sourceText = (s: RepoRef) => `github:${s.owner}/${s.repo}${s.path ? `/${s.path}` : ""}@${s.ref}`;
export const sameRepo = (a: Pick<RepoRef, "owner" | "repo" | "path">, b: Pick<RepoRef, "owner" | "repo" | "path">) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && (a.path ?? "") === (b.path ?? "");
const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const reconnectMessage = (s: Pick<RepoRef, "owner" | "repo">) => `Canon's GitHub App no longer has access to ${s.owner}/${s.repo}; reconnect GitHub on the Customization page.`;

const rawBase = () => process.env.RECIPE_GITHUB_RAW_BASE || "https://raw.githubusercontent.com";
const repoPath = (s: RepoRef) => `${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;
const filePath = (s: RepoRef, file: string) => `${s.path ? `${s.path.split("/").map(encodeURIComponent).join("/")}/` : ""}${file}`;

/** The body as text, refused past `max` bytes without reading the rest. */
async function capped(res: Response, max: number, what: string): Promise<string> {
  const tooBig = () => refuse(`${what} is larger than ${Math.round(max / 1024)} KB.`);
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body?.cancel(); return tooBig(); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return tooBig(); }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[]).text();
}

/** How one operation reads a repo: its token, if private, and what a 404 or a refusal means for it. */
type Access = { token: string | null; notFound: string; refused: (status: number) => string };

async function get(url: string, accept: string, max: number, what: string, access: Access): Promise<string>;
async function get(url: string, accept: string, max: number, what: string, access: Access, optional: true): Promise<string | null>;
async function get(url: string, accept: string, max: number, what: string, access: Access, optional = false): Promise<string | null> {
  let res: Response;
  try {
    const headers: Record<string, string> = { accept, "user-agent": "canon-recipes", ...(access.token ? { authorization: `Bearer ${access.token}` } : {}) };
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return refuse(timedOut ? `GitHub didn't answer for ${what} within ${FETCH_TIMEOUT_MS / 1000} s.` : `Couldn't reach GitHub for ${what}.`);
  }
  if (res.status === 404) { await res.body?.cancel(); return optional ? null : refuse(`${what} wasn't found. ${access.notFound}`); }
  if (res.status === 401 || res.status === 403 || res.status === 429) { await res.body?.cancel(); return refuse(access.refused(res.status)); }
  if (!res.ok) { await res.body?.cancel(); return refuse(`GitHub answered ${res.status} for ${what}.`); }
  return capped(res, max, what);
}

const PUBLIC: Access = {
  token: null,
  notFound: "Check the source, and that the repo is public or in a GitHub account connected on the Customization page.",
  refused: (status) => (status === 401 ? `GitHub refused the request (${status}).` : `GitHub refused the request (${status}); its unauthenticated rate limit may be spent. Try again later.`),
};

const BAD_APP = "GitHub refused Canon's App credentials. Check GITHUB_RECIPES_APP_ID and GITHUB_RECIPES_APP_PRIVATE_KEY.";

/** A token for one private repo, or the reconnect error when the App lost it. A wrong App id or key says so instead. */
async function appToken(installationId: number, s: RepoRef): Promise<string> {
  try {
    return await installationToken(installationId, s.repo);
  } catch (e) {
    if (e instanceof GithubAppError) throw new ConvexError(e.status === 401 ? BAD_APP : reconnectMessage(s));
    throw e;
  }
}

/**
 * The source a user's `github:` text names in this workspace: read through the App when one of the workspace's
 * connections covers the owner and can see the repo as private, else public. The user pastes the same text either way.
 */
export async function resolveSource(r: RepoRef, connections: readonly Connection[]): Promise<RecipeSource> {
  for (const c of connections.filter((c) => covers(c, r))) {
    let token: string;
    try {
      token = await installationToken(c.installationId, r.repo);
    } catch (e) {
      if (!(e instanceof GithubAppError)) throw e;
      if (e.status === 401) throw new ConvexError(BAD_APP);
      continue;
    }
    const meta = await get(`${apiBase()}/repos/${repoPath(r)}`, "application/vnd.github+json", 256 * 1024, `${r.owner}/${r.repo}`, { token, notFound: "", refused: () => reconnectMessage(r) });
    const isPrivate = (() => { try { return (JSON.parse(meta) as { private?: unknown }).private === true; } catch { return false; } })();
    if (isPrivate) return { kind: "github-app", installationId: c.installationId, ...r };
  }
  return { kind: "github-public", ...r };
}

/** One operation's reads of a source: the commit a ref names, the tags, and the package at a commit. */
export type SourceReader = {
  resolveSha(ref?: string): Promise<string>;
  tags(): Promise<Array<{ name: string; sha: string }>>;
  /** customization.md (or recipe.md), and its bundle when the package has code: a markdown-only package has none. */
  fetchPackage(sha: string): Promise<{ markdown: string; code: string | null }>;
  /** One file of the package at a commit, refused past `max` bytes: a module's module.json. */
  fetchFile(sha: string, name: string, max: number): Promise<string>;
};

/** Where GitHub's API and raw files are read: GitHub, or the local fixture a local stack's install names. */
export type SourceBases = { api: string; raw: string };

/**
 * Open `source` for one operation. A private source must be on one of the workspace's `connections`, so a package
 * can't be read through another workspace's installation, and gets a token minted here and dropped with the reader.
 */
export async function openSource(source: RecipeSource, connections: readonly Connection[], bases?: SourceBases): Promise<SourceReader> {
  let access = PUBLIC;
  if (source.kind === "github-app") {
    const id = source.installationId;
    if (!connections.some((c) => c.installationId === id && covers(c, source))) throw new ConvexError(reconnectMessage(source));
    const token = await appToken(id, source);
    access = { token, notFound: `Check the source, and that ${source.owner}/${source.repo} has it.`, refused: (status) => (status === 429 ? `GitHub rate-limited Canon's App (${status}). Try again later.` : reconnectMessage(source)) };
  }
  const api = `${bases?.api ?? apiBase()}/repos/${repoPath(source)}`;
  const url = (sha: string, name: string) => source.kind === "github-app" ? `${api}/contents/${filePath(source, name)}?ref=${sha}` : `${bases?.raw ?? rawBase()}/${repoPath(source)}/${sha}/${filePath(source, name)}`;
  const accept = (type: string) => (source.kind === "github-app" ? "application/vnd.github.raw+json" : type);
  return {
    async resolveSha(ref = source.ref) {
      const sha = (await get(`${api}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`, "application/vnd.github.sha", 1024, sourceText({ ...source, ref }), access)).trim();
      return SHA.test(sha) ? sha : refuse(`GitHub didn't return a commit for ${sourceText({ ...source, ref })}.`);
    },
    async tags() {
      const text = await get(`${api}/tags?per_page=100`, "application/vnd.github+json", 256 * 1024, `the tags of ${source.owner}/${source.repo}`, access);
      const rows = (() => { try { return JSON.parse(text) as unknown; } catch { return null; } })();
      if (!Array.isArray(rows)) return refuse(`GitHub didn't return a tag list for ${source.owner}/${source.repo}.`);
      return rows.flatMap((t) => (t && typeof t.name === "string" && typeof t.commit?.sha === "string" && SHA.test(t.commit.sha) ? [{ name: t.name as string, sha: t.commit.sha as string }] : []));
    },
    async fetchPackage(sha) {
      if (!SHA.test(sha)) return refuse("A pinned commit is 40 hex characters.");
      // Both settle before either's error is thrown: a refused markdown file must not leave the bundle's fetch running.
      const pair = async (md: string, js: string, legacy: boolean) => {
        const [markdown, code] = await Promise.allSettled([
          legacy ? get(url(sha, md), accept("text/markdown, text/plain"), RECIPE_MAX_BYTES, RECIPE_FILE, access)
            : get(url(sha, md), accept("text/markdown, text/plain"), RECIPE_MAX_BYTES, RECIPE_FILE, access, true),
          get(url(sha, js), accept("text/javascript, text/plain"), BUNDLE_MAX_BYTES, BUNDLE_FILE, access, true),
        ]);
        if (markdown.status === "rejected") throw markdown.reason;
        if (code.status === "rejected") throw code.reason;
        return markdown.value === null ? null : { markdown: markdown.value, code: code.value };
      };
      // A package published before customizations were named holds recipe.md and dist/recipe.js instead.
      return (await pair(RECIPE_FILE, BUNDLE_FILE, false)) ?? (await pair(LEGACY_FILES.markdown, LEGACY_FILES.bundle, true))!;
    },
    async fetchFile(sha, name, max) {
      if (!SHA.test(sha)) return refuse("A pinned commit is 40 hex characters.");
      return get(url(sha, name), accept("application/json, text/plain"), max, name, access);
    },
  };
}
