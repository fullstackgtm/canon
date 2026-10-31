import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readJsonBody,
  requireAction,
  unsupportedAction,
} from "../src/app/api/gtm/_lib.ts";

test("readJsonBody returns an object for valid JSON object payloads", async () => {
  const request = new Request("http://localhost/api/gtm/example", {
    method: "POST",
    body: JSON.stringify({ action: "generateFromCrm" }),
  });

  assert.deepEqual(await readJsonBody(request), { action: "generateFromCrm" });
});

test("readJsonBody normalizes invalid or non-object payloads", async () => {
  const invalid = new Request("http://localhost/api/gtm/example", {
    method: "POST",
    body: "{",
  });
  const array = new Request("http://localhost/api/gtm/example", {
    method: "POST",
    body: JSON.stringify(["generateFromCrm"]),
  });

  assert.deepEqual(await readJsonBody(invalid), {});
  assert.deepEqual(await readJsonBody(array), {});
});

test("requireAction allows missing or matching actions and rejects mismatches", async () => {
  assert.equal(await requireAction({}, "generateFromCrm"), null);
  assert.equal(
    await requireAction({ action: "generateFromCrm" }, "generateFromCrm"),
    null,
  );

  const response = await requireAction(
    { action: "deleteEverything" },
    "generateFromCrm",
  );
  assert.equal(response?.status, 400);
  assert.deepEqual(await response?.json(), {
    ok: false,
    error: {
      code: "UNSUPPORTED_ACTION",
      message: "Unsupported action",
      hints: ["Check the route documentation or run `npm run gtm -- surface --json` to inspect supported surfaces."],
    },
  });
});

test("unsupportedAction returns the stable API error envelope", async () => {
  const response = unsupportedAction();

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "UNSUPPORTED_ACTION",
      message: "Unsupported action",
      hints: ["Check the route documentation or run `npm run gtm -- surface --json` to inspect supported surfaces."],
    },
  });
});
