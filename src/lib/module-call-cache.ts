export class ModuleCallCache<T> {
  private readonly saved = new Map<string, { value: T }>();
  private revision = 0;
  private readonly latest = new Map<string, symbol>();
  private readonly pending = new Map<string, Promise<T>>();

  get(key: string): { value: T } | undefined {
    return this.saved.get(key);
  }

  async load(key: string, supply: () => Promise<T>, fresh = false): Promise<T> {
    const saved = this.saved.get(key);
    if (!fresh && saved) return saved.value;
    const pending = this.pending.get(key);
    if (!fresh && pending) return pending;

    const revision = this.revision;
    const request = Symbol();
    this.latest.set(key, request);
    const read = supply().then((value) => {
      if (revision === this.revision && this.latest.get(key) === request) {
        this.saved.set(key, { value });
        if (this.saved.size > 512) this.saved.delete(this.saved.keys().next().value!);
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === read) this.pending.delete(key);
      if (this.latest.get(key) === request) this.latest.delete(key);
    });
    this.pending.set(key, read);
    return read;
  }

  invalidate(): void {
    this.revision++;
    this.saved.clear();
    this.latest.clear();
    this.pending.clear();
  }
}

export const moduleCallCache = new ModuleCallCache<unknown>();
