import assert from "node:assert/strict";
import { test } from "node:test";
import { DEAL_FILTER_DEFAULTS, isDefaultDealFilter, matchesDealStatus } from "../src/lib/deal-filter.ts";
import { parseUrlState, serializeUrlState } from "../src/lib/url-state-core.ts";

const open = { isClosed: false, isWon: false }, won = { isClosed: true, isWon: true }, lost = { isClosed: true, isWon: false };
function dealsPageAfter(search: string, patch: Partial<typeof DEAL_FILTER_DEFAULTS>) {
  const qs = serializeUrlState(search, DEAL_FILTER_DEFAULTS, patch);
  const state = parseUrlState(new URLSearchParams(qs), DEAL_FILTER_DEFAULTS);
  const shown = Object.entries({ open, won, lost }).filter(([, deal]) => matchesDealStatus(state.status, deal)).map(([name]) => name);
  return { qs, state, shown };
}

test("Deals All survives the URL, and Clear returns to Open with an empty query", () => {
  const initial = dealsPageAfter("", {});
  assert.deepEqual([initial.qs, initial.shown, isDefaultDealFilter(initial.state)], ["", ["open"], true]);

  const all = dealsPageAfter("", { status: "all" });
  assert.deepEqual([all.qs, all.shown, isDefaultDealFilter(all.state)], ["status=all", ["open", "won", "lost"], false]);

  const searched = dealsPageAfter(all.qs, { q: "acme" });
  assert.deepEqual(searched.shown, ["open", "won", "lost"]);
  assert.equal(dealsPageAfter("status=won", {}).shown.join(), "won");

  const cleared = dealsPageAfter(searched.qs, DEAL_FILTER_DEFAULTS);
  assert.deepEqual([cleared.qs, cleared.state, cleared.shown, isDefaultDealFilter(cleared.state)], ["", DEAL_FILTER_DEFAULTS, ["open"], true]);
  assert.equal(isDefaultDealFilter(dealsPageAfter("", { q: "acme" }).state), false);
});
