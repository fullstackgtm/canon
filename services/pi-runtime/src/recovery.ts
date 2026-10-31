export type Recovery = { checkpointAt: number; attempts: number };

export function nextRecovery(previous: Recovery | undefined, checkpointAt: number): Recovery {
  return { checkpointAt, attempts: checkpointAt !== previous?.checkpointAt ? 1 : (previous?.attempts ?? 0) + 1 };
}
