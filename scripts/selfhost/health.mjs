import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeAnswers, runtimeChoice } from "./recipeRuntime.mjs";

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   readyFile?: string,
 *   fetchImpl?: typeof fetch,
 *   checkRuntime?: typeof runtimeAnswers,
 *   checkReady?: () => Promise<void>,
 * }} [options]
 */
export async function checkHealth({
  env = /** @type {Record<string, string | undefined>} */ (process.env),
  readyFile = "/tmp/canoncrm-ready",
  fetchImpl = fetch,
  checkRuntime = runtimeAnswers,
  checkReady = () => access(readyFile),
} = {}) {
  await checkReady();
  for (const url of ["http://127.0.0.1:3210/version", "http://127.0.0.1:8787/healthz", `http://127.0.0.1:${env.PORT || "3000"}/api/public/version`]) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Health check failed at ${url}`);
    await response.arrayBuffer();
  }
  const runtime = runtimeChoice(env);
  if (runtime.builtIn && !(await checkRuntime(runtime.url, 1500))) {
    throw new Error(`Health check failed at ${runtime.url}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkHealth();
  } catch {
    process.exit(1);
  }
}
