// Read-only guard: wraps the Salesforce port so that, while read-only is on,
// any write is refused and counted. The engine already never calls patch in
// read-only mode; this wrapper makes that an asserted invariant rather than a
// convention. `isReadOnly` is consulted on every write, so a flip made while a
// tick is running takes effect before the next PATCH.
import type { SfPort } from "./types.ts";

export class ReadOnlyViolation extends Error {
  constructor(sfObject: string, sfId: string) {
    super(`read-only: refused Salesforce write to ${sfObject} ${sfId}`);
  }
}

export type GuardedSfPort = SfPort & { writes(): number; writeAttempts(): number };

export function guardSfPort(inner: SfPort, isReadOnly: () => boolean | Promise<boolean>): GuardedSfPort {
  let writes = 0;
  let attempts = 0;
  return {
    fetch: (o, ids, f) => inner.fetch(o, ids, f),
    async patch(sfObject, sfId, fields) {
      attempts++;
      if (await isReadOnly()) throw new ReadOnlyViolation(sfObject, sfId);
      await inner.patch(sfObject, sfId, fields);
      writes++;
    },
    writes: () => writes,
    writeAttempts: () => attempts,
  };
}
