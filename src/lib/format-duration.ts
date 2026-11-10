export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 60) {
    const seconds = Math.floor(durationMs / 1000) % 60;
    return `${minutes}m ${seconds}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
