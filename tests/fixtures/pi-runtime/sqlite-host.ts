import { writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openRuntime, context } from "../../../services/pi-runtime/src/runtime.ts";

const [kind, key, output] = process.argv.slice(2);
if (kind !== "sqlite" || !/^pi-probe-[a-zA-Z0-9-]+$/.test(key) || !output) throw new Error("Invalid local probe arguments");
const path = resolve(output);
const storage = await openNodeSqliteStorage(`${path}.sqlite`);
let saving = Promise.resolve();
const runtime = await openRuntime(storage, async () => { throw new Error("Probe cannot call Canon or vendors"); }, () => {
  saving = saving.then(async () => {
    await writeFile(`${path}.tmp`, JSON.stringify(await runtime.snapshot()));
    await rename(`${path}.tmp`, path);
  });
});
const id = await runtime.start({ runId: key, mode: "probe", delayMs: 300 });
console.log(JSON.stringify({ ready: true, at: Date.now() }));
const settled = await runtime.wait(id);
if (settled.state.outcome.status !== "completed") throw new Error(`Probe ended ${settled.state.outcome.status}`);
await saving;
await writeFile(`${path}.tmp`, JSON.stringify(await runtime.snapshot()));
await rename(`${path}.tmp`, path);
await runtime.harness.close(context);
