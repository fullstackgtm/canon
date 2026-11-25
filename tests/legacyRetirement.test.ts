import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex } from "./convexHandlers.ts";

const functions = loadConvex(["competitive.ts", "forecasting.ts"]);

test("retired generation and forecast entry points refuse before reading or writing legacy data", async () => {
  for (const [file, name] of [["competitive.ts", "generateFromDeals"], ["forecasting.ts", "getCurrentForecast"], ["forecasting.ts", "getForecastByRep"]]) {
    await assert.rejects(functions[file][name].handler({ db: new Proxy({}, { get: () => { throw new Error("Unexpected database access"); } }) }, {}), /retired/);
  }
});
