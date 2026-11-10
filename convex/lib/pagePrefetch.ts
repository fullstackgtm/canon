/**
 * Read cursor-paged results ahead of their consumer: pages are read one after another (each names the next) into a
 * buffer of at most `max`, while the consumer writes the earlier ones. A sync's people and deals read this way while
 * its companies are still being written, and start writing from the buffer once they are in.
 *
 * Pure apart from timers: no Node-only imports.
 */

export type PrefetchedPages<P> = {
  /** The next page in order, or undefined once the last was read (or the reader stopped). Throws the read's error. */
  next(): Promise<P | undefined>;
  /** Read no further; pages already read stay available. */
  stop(): void;
};

/** Read pages from `first` until one has no `next`, `until` passes, or stop(), at most `max` ahead of the consumer. */
export function prefetchPages<P extends { next: string | null }>(
  first: string | null,
  read: (after: string | null) => Promise<P>,
  o: { max: number; until: number },
): PrefetchedPages<P> {
  const buffered: P[] = [];
  let failure: { error: unknown } | undefined;
  let finished = false;
  let stopped = false;
  let wake: (() => void) | undefined;
  let space: (() => void) | undefined;
  const signal = () => {
    wake?.();
    wake = undefined;
  };
  void (async () => {
    let after = first;
    try {
      while (!stopped) {
        while (buffered.length >= o.max && !stopped) await new Promise<void>((r) => (space = r));
        if (stopped) break;
        const page = await read(after);
        buffered.push(page);
        signal();
        if (!page.next || Date.now() >= o.until) break;
        after = page.next;
      }
    } catch (error) {
      failure = { error };
    } finally {
      finished = true;
      signal();
    }
  })();
  return {
    async next() {
      while (!buffered.length && !finished) await new Promise<void>((r) => (wake = r));
      const page = buffered.shift();
      space?.();
      space = undefined;
      if (page) return page;
      if (failure) throw failure.error;
      return undefined;
    },
    stop() {
      stopped = true;
      space?.();
      space = undefined;
    },
  };
}

/**
 * Write pages taken from `next`, up to `max` at once, and commit each in order: `commit` runs for a page only once it
 * and every page taken before it are written, so a cursor advanced by `commit` never passes an unwritten page. `more`
 * says whether to take another page (asked before taking it and again once it arrives). After a failed read or write
 * no page is taken, the writes already running settle, and then it throws.
 */
export async function writeInOrder<P>(o: {
  next: () => Promise<P | undefined>;
  more: (taken: number) => boolean;
  max: number;
  write: (page: P) => Promise<void>;
  commit: (page: P) => void;
}): Promise<void> {
  const running = new Set<Promise<void>>();
  const written = new Map<number, P>();
  let taken = 0;
  let committed = 0;
  let failure: { error: unknown } | undefined;
  while (!failure && o.more(taken)) {
    if (running.size >= o.max) {
      await Promise.race(running);
      continue;
    }
    let page: P | undefined;
    try {
      page = await o.next();
    } catch (error) {
      // A failed read stops the lane like a failed write: the writes already running settle first.
      failure ??= { error };
      break;
    }
    if (page === undefined || failure || (taken > 0 && !o.more(taken))) break;
    const seq = taken++;
    const task: Promise<void> = o.write(page).then(
      () => {
        written.set(seq, page);
        while (written.has(committed)) {
          const done = written.get(committed)!;
          written.delete(committed++);
          o.commit(done);
        }
      },
      (error) => {
        failure ??= { error };
      },
    );
    running.add(task);
    void task.then(() => running.delete(task));
  }
  await Promise.all(running);
  if (failure) throw failure.error;
}
