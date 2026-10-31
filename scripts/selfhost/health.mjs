import { access } from "node:fs/promises";

try {
  await access("/tmp/canoncrm-ready");
  for (const url of ["http://127.0.0.1:3210/version", "http://127.0.0.1:8787/healthz", `http://127.0.0.1:${process.env.PORT || "3000"}/api/public/version`]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Health check failed at ${url}`);
    await response.arrayBuffer();
  }
} catch {
  process.exit(1);
}
