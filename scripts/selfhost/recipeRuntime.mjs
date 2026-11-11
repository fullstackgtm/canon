// The recipe runtime the container starts when the operator names none (docs/self-hosting.md, "Module server code").

/** Where Convex reaches the built-in runtime. Loopback only: nothing outside the container can call it. */
export const BUILT_IN_RUNTIME = "http://127.0.0.1:8790";

/** The operator's own runtime when RECIPE_RUNTIME_URL is set (Compose passes an unset one as ""), else the built-in one. */
export function runtimeChoice(env) {
  const url = env.RECIPE_RUNTIME_URL?.trim();
  return url ? { builtIn: false, url } : { builtIn: true, url: BUILT_IN_RUNTIME };
}

/** Whether the runtime answers: an unsigned POST /run is refused with 401 by a live one. */
export async function runtimeAnswers(url, timeoutMs) {
  try {
    const response = await fetch(new URL("/run", url), { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return response.status === 401;
  } catch {
    return false;
  }
}

/**
 * Keeps the runtime running. Open-source workerd enforces no CPU limit, so a module call stuck in a loop freezes every
 * isolate in it: after `misses` probes in a row without an answer the process is killed and started again. A runtime
 * that exits on its own is started again too, but more than `maxRestarts` such exits within `windowMs` call `giveUp`,
 * as any other child's exit stops the container. A stuck call never does: it is a module's bug, not the container's.
 * `launch()` returns `{ kill, exited }`, where `exited` settles when the process is gone.
 */
export function keepAlive({ launch, answers, log, giveUp, stopping, probeMs = 5000, misses = 3, maxRestarts = 5, windowMs = 60_000, now = Date.now }) {
  const exits = [];
  let current;
  let missed = 0;
  const run = () => {
    const process = { ...launch(), killed: false };
    current = process;
    process.exited.then(() => {
      if (stopping() || current !== process) return;
      if (!process.killed) {
        const at = now();
        exits.push(at);
        while (exits.length && exits[0] <= at - windowMs) exits.shift();
        if (exits.length > maxRestarts) return giveUp(`The recipe runtime exited ${exits.length} times in ${windowMs / 1000} s`);
        log("Recipe runtime exited; starting it again");
      }
      run();
    });
  };
  run();
  const timer = setInterval(async () => {
    if (stopping()) return clearInterval(timer);
    if (await answers()) { missed = 0; return; }
    if (++missed < misses) return;
    missed = 0;
    log("Recipe runtime stopped answering, likely a module call stuck in a loop; restarting it");
    current.killed = true;
    current.kill("SIGKILL");
  }, probeMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
