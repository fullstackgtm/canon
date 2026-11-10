/**
 * The recipe editor's draft (docs/recipes.md, "Editing with an agent"): the revision it was opened on, the text being
 * edited, and the Ask Canon proposal waiting on it. Only a save moves `base`; accepting a proposal changes the draft
 * alone, so nothing is saved until the person clicks Save. Pure, so the transitions are tested without React.
 */
import type { Proposal } from "../../../../convex/lib/recipeAgent";
import { merge3 } from "../../../../recipes/merge.ts";

export type AgentProposal = Proposal & { model: string };

export type Exchange = { request: string; outcome: "accepted" | "discarded" | "failed"; note: string };

export type DraftState = {
  base: { revision: number; markdown: string };
  draft: string;
  /** A request in flight, with the draft it was asked about. */
  asking: { request: string; from: string } | null;
  proposal: { request: string; from: string; result: AgentProposal } | null;
  /** This session's requests, oldest first, so a follow-up reads as one. */
  log: Exchange[];
  /** The upstream version merged into the draft, which the save records; null when the draft merges none. */
  merging: string | null;
  /** The drafts before each Visual layout edit, newest last. Any other change to the draft ends it. */
  undo: string[];
};

export type DraftAction =
  | { kind: "edit"; draft: string }
  /** A Visual layout edit, which Undo can take back. */
  | { kind: "layout"; draft: string }
  | { kind: "undo" }
  | { kind: "ask"; request: string }
  | { kind: "proposed"; result: AgentProposal }
  | { kind: "failed"; message: string }
  | { kind: "accept" }
  | { kind: "discard" }
  | { kind: "saved"; revision: number; markdown: string }
  /** A revision saved elsewhere, taken only while nothing is edited. */
  | { kind: "landed"; revision: number; markdown: string }
  | { kind: "reset" }
  /** The upstream at `version` merged into the draft as it is when the fetch returns, so edits typed meanwhile stay (recipes/merge.ts). */
  | { kind: "merged"; base: string; theirs: string; version: string };

export const openDraft = (revision: number, markdown: string): DraftState => ({ base: { revision, markdown }, draft: markdown, asking: null, proposal: null, log: [], merging: null, undo: [] });

export const isDirty = (s: DraftState) => s.draft !== s.base.markdown || s.merging !== null;

const UNDO_DEPTH = 50;

/**
 * Undo reaches back only through Visual's own edits, so it survives a switch to Markdown and back. Any other action
 * that changes the draft (typing, a revert landing, an accepted proposal, a merge, discarding) ends the history.
 */
export function draftReducer(s: DraftState, a: DraftAction): DraftState {
  if (a.kind === "layout") return a.draft === s.draft ? s : { ...s, draft: a.draft, undo: [...s.undo.slice(-(UNDO_DEPTH - 1)), s.draft] };
  if (a.kind === "undo") return s.undo.length ? { ...s, draft: s.undo[s.undo.length - 1], undo: s.undo.slice(0, -1) } : s;
  const next = step(s, a);
  return next.draft !== s.draft && next.undo.length ? { ...next, undo: [] } : next;
}

function step(s: DraftState, a: Exclude<DraftAction, { kind: "layout" | "undo" }>): DraftState {
  switch (a.kind) {
    case "edit":
      return { ...s, draft: a.draft };
    case "ask":
      return s.asking ? s : { ...s, asking: { request: a.request, from: s.draft }, proposal: null };
    case "proposed":
      return s.asking ? { ...s, asking: null, proposal: { ...s.asking, result: a.result } } : s;
    case "failed":
      return s.asking ? { ...s, asking: null, log: [...s.log, { request: s.asking.request, outcome: "failed", note: a.message }] } : s;
    case "accept":
      if (!s.proposal) return s;
      return { ...s, draft: s.proposal.result.markdown, proposal: null, log: [...s.log, { request: s.proposal.request, outcome: "accepted", note: s.proposal.result.summary }] };
    case "discard":
      return s.proposal ? { ...s, proposal: null, log: [...s.log, { request: s.proposal.request, outcome: "discarded", note: s.proposal.result.summary }] } : s;
    case "saved":
      return { ...s, base: { revision: a.revision, markdown: a.markdown }, merging: null };
    case "landed":
      return isDirty(s) || a.revision === s.base.revision ? s : { ...s, base: { revision: a.revision, markdown: a.markdown }, draft: a.markdown };
    case "reset":
      return { ...s, draft: s.base.markdown, proposal: null, merging: null };
    case "merged":
      return { ...s, draft: merge3(a.base, s.draft, a.theirs, `upstream v${a.version}`).text, merging: a.version };
  }
}
