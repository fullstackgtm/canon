import { MemoryStorage, type Id, type Seq, type StorageWrite } from "@earendil-works/pi-durable";
import { context } from "./runtime.ts";

type Remote = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class ConvexLeaseStorage extends MemoryStorage {
  private epoch = 0;
  private sequence = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private fenced = false;
  private remote: Remote;
  private key: string;
  private holder: string;
  constructor(remote: Remote, key: string, holder: string) {
    super();
    this.remote = remote;
    this.key = key;
    this.holder = holder;
  }

  async acquire() {
    const loaded = await this.call("acquire");
    this.epoch = loaded.epoch as number;
    for (const commit of loaded.commits as Array<{ seq: number; writes: string }>) {
      this.prepareCommit(JSON.parse(commit.writes), commit.seq as Seq).apply();
    }
    this.sequence = loaded.seq as number;
    this.heartbeat = setInterval(() => { void this.call("heartbeat").catch(() => { this.fenced = true; }); }, 750);
    return this;
  }

  private call(operation: string, data: Record<string, unknown> = {}) {
    if (this.fenced) throw new Error("Lease lost");
    return this.remote({ operation, key: this.key, holder: this.holder, epoch: this.epoch, ...data });
  }

  override async mintId<I extends Id<string>>(): Promise<I> {
    const minimum = await super.mintId<I>();
    return (await this.call("mint", { minimum })).id as I;
  }

  override async commit(writes: readonly StorageWrite[]): Promise<Seq> {
    const seq = (this.sequence + 1) as Seq;
    const prepared = this.prepareCommit(writes, seq);
    await this.call("commit", { seq, writes: JSON.stringify(prepared.writes) });
    this.sequence = seq;
    return prepared.apply();
  }

  override async close() {
    clearInterval(this.heartbeat);
    await super.close(context);
  }
}
