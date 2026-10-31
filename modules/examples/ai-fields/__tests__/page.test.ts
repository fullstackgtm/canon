import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CANON_LABELS, parseModuleManifest, type Column } from "../../../kernel/manifest.ts";
import { columnText, renderText, type Doc } from "../../../kernel/text.ts";

test("AI fields columns render hosted research values and their empty alternatives", () => {
  const parsed = parseModuleManifest(JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const table = parsed.manifest.pages[0].body.find((n) => n.c === "table")!;
  assert.equal(table.c, "table");
  if (table.c !== "table") return;
  const render = (data: Record<string, unknown>) => {
    const row: Doc = { key: "buyer", version: 0, owner: null, data };
    return table.columns.map((c: Column) => renderText(columnText(c, row), { binds: {}, row, rowLabels: CANON_LABELS.research, currency: "USD", members: new Map() }) || c.empty || "");
  };
  assert.deepEqual(render({ label: "Buyer", kind: "qa", answerType: "text", entity: "contact", owner: "Ada", agentStatus: "active", autoAccept: 0.8,
    refreshCadence: "weekly", refreshHold: "Owner paused", latestRun: { status: "done", answered: 3, errors: 0 } }),
    ["Buyer", "Question · text", "People", "Ada · Active", "Auto-accept ≥ 0.8", "Weekly · Paused", "Done · 3 answered · 0 errors"]);
  assert.deepEqual(render({ label: "Segment", kind: "classify", entity: "account", agentStatus: "paused" }),
    ["Segment", "Classify", "Accounts", "unknown · Paused", "Manual review", "Off", "Not run yet"]);
});
