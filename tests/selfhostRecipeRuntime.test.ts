import assert from "node:assert/strict";
import test from "node:test";
import { keepAlive, runtimeChoice } from "../scripts/selfhost/recipeRuntime.mjs";

test("the container runs its own recipe runtime on loopback unless the operator names one", () => {
  assert.deepEqual(runtimeChoice({}), { builtIn: true, url: "http://127.0.0.1:8790" });
  assert.deepEqual(runtimeChoice({ RECIPE_RUNTIME_URL: " " }), { builtIn: true, url: "http://127.0.0.1:8790" }, "Compose passes an unset key as empty");
  assert.deepEqual(runtimeChoice({ RECIPE_RUNTIME_URL: "https://runtime.example.com" }), { builtIn: false, url: "https://runtime.example.com" });
});

test("a runtime that stops answering is killed and started again, and one that keeps exiting stops the container", async () => {
  const processes: { signal?: string; exit: () => void }[] = [];
  const reasons: string[] = [];
  let unanswered = 0;
    const supervisor = keepAlive({
    launch: () => {
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => { exit = resolve; });
      const process: { signal?: string; exit: () => void } = { exit };
      processes.push(process);
      return { kill: (signal: string) => { process.signal = signal; exit(); }, exited };
    },
    answers: async () => (unanswered > 0 ? (unanswered--, false) : true),
    log: () => {},
    giveUp: (reason: string) => reasons.push(reason),
    stopping: () => false,
    probeMs: 2, misses: 2, maxRestarts: 2,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const exitLatest = async () => { processes.at(-1)!.exit(); await settle(); };
  await settle();
  assert.equal(processes.length, 1, "an answering runtime is left alone");
  unanswered = 2;
  await settle();
  assert.deepEqual([processes.length, processes[0].signal], [2, "SIGKILL"], "two missed probes replace the runtime");
  await exitLatest();
  await exitLatest();
  assert.deepEqual([processes.length, reasons.length], [4, 0], "a runtime that exits is started again");
  await exitLatest();
  assert.deepEqual([processes.length, reasons.length], [4, 1], "a third exit within a minute gives up; the watchdog's own kill never counts");
  supervisor.stop();
});
