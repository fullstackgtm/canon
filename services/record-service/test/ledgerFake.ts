// A stand-in for Convex's ledger feed (convex/http.ts /ledger/*): an in-memory
// ledger per org, served over HTTP with the same routes, parameters and auth.
import { createServer, type Server } from "node:http";
import type { EntryBody } from "../src/core/objects/fold.ts";
import { associationObjectDef, plainObjectDef, resolveObjectDef, STANDARD_OBJECTS, type ObjectDef, type OrgObjectExtension, type StandardObjectName } from "../src/core/objects/registry.ts";
import type { WireEntry } from "../src/projector.ts";

import { TOKEN } from "./helpers.ts";

/** The shard Convex assigns a stream (convex/lib/objects/write.ts shardOf). */
export function shardOf(streamId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < streamId.length; i++) {
    h ^= streamId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 16;
}

export class FakeLedger {
  readonly entries = new Map<string, WireEntry[]>();
  readonly extensions = new Map<string, Partial<Record<StandardObjectName, OrgObjectExtension>>>();
  requests = 0;
  /** Delay before answering each /ledger/tail request. */
  tailDelayMs = 0;
  /** At most this many entries per tail page, whatever the limit: Convex cuts a page short at its byte budget. */
  tailCap = Infinity;
  private server: Server | null = null;

  append(org: string, object: StandardObjectName | "association", streamId: string, body: EntryBody, observedAt: number, source: WireEntry["source"] = { kind: "user", ref: "user:u1" }): WireEntry {
    const list = this.entries.get(org) ?? [];
    this.entries.set(org, list);
    const shard = shardOf(streamId);
    const version = list.filter((e) => e.streamId === streamId).length + 1;
    const seq = list.filter((e) => e.shard === shard).length + 1;
    const entry: WireEntry = {
      streamId, version, observedAt, object, shard, seq, body,
      source, actor: { kind: source.kind === "user" ? "user" : "integration", id: source.kind === "user" ? "u1" : source.kind },
    };
    list.push(entry);
    return entry;
  }

  set(org: string, object: StandardObjectName | "association", streamId: string, values: Record<string, unknown>, observedAt: number, source?: WireEntry["source"]) {
    return this.append(org, object, streamId, {
      kind: "assert", status: "accepted",
      assertions: Object.entries(values).map(([fieldId, value]) => ({ fieldId, value })),
    } as unknown as EntryBody, observedAt, source);
  }

  defs(org: string): ObjectDef[] {
    const ext = this.extensions.get(org) ?? {};
    // Edge streams, as convex/ledgerFeed.ts orgObjectDefs serves them (CP3).
    return (Object.keys(STANDARD_OBJECTS) as StandardObjectName[]).map((o) => plainObjectDef(resolveObjectDef(STANDARD_OBJECTS[o], ext[o]))).concat(plainObjectDef(associationObjectDef()));
  }

  heads(org: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries.get(org) ?? []) out[String(e.shard)] = Math.max(out[String(e.shard)] ?? 0, e.seq);
    return out;
  }

  async listen(): Promise<string> {
    this.server = createServer(async (req, res) => {
      this.requests++;
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
      const org = url.searchParams.get("org") ?? "";
      const all = this.entries.get(org) ?? [];
      const num = (k: string) => Number(url.searchParams.get(k));
      if (url.pathname === "/ledger/tail") {
        if (this.tailDelayMs) await new Promise((r) => setTimeout(r, this.tailDelayMs));
        const shard = num("shard");
        const after = num("after");
        const entries = all.filter((e) => e.shard === shard && e.seq > after).sort((a, b) => a.seq - b.seq).slice(0, Math.min(num("limit"), this.tailCap));
        return send(200, { entries, head: this.heads(org)[String(shard)] ?? 0 });
      }
      if (url.pathname === "/ledger/heads") return send(200, { heads: this.heads(org), defs: this.defs(org) });
      if (url.pathname === "/ledger/stream") {
        const id = url.searchParams.get("id");
        const entries = all.filter((e) => e.streamId === id && e.version >= num("fromVersion")).sort((a, b) => a.version - b.version);
        const page = entries.slice(0, num("limit"));
        return send(200, { entries: page, done: page.length === entries.length });
      }
      send(404, { error: "not found" });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  close() {
    return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
