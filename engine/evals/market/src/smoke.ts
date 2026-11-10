import { runOne } from "./runner.ts";

const raw = await runOne("creative-intelligence-mini", "fixture/perfect", "raw");
const fsgtm = await runOne("creative-intelligence-mini", "fixture/perfect", "fsgtm");
const sloppy = await runOne("creative-intelligence-mini", "fixture/sloppy", "raw");

console.log(JSON.stringify({
  raw: { score: raw.taskScore, hardGatePass: raw.metrics.hardGatePass, violations: raw.violations.length },
  fsgtm: { score: fsgtm.taskScore, hardGatePass: fsgtm.metrics.hardGatePass, violations: fsgtm.violations.length, toolCalls: fsgtm.toolCalls },
  sloppy: { score: sloppy.taskScore, hardGatePass: sloppy.metrics.hardGatePass, violations: sloppy.violations.length },
}, null, 2));

if (!raw.metrics.hardGatePass || raw.taskScore < 99) throw new Error("fixture/perfect raw should pass");
if (!fsgtm.metrics.hardGatePass || fsgtm.taskScore < 99 || fsgtm.toolCalls < 3) throw new Error("fixture/perfect fsgtm should pass and call CLI");
if (sloppy.taskScore >= 90 || sloppy.violations.length === 0) throw new Error("fixture/sloppy should score lower and emit classification violations");
