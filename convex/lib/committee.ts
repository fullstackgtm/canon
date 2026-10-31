/**
 * A deal's buying committee (docs/account-plays.md): the people on the buyer's
 * side, each in a slot. Each is a `deal_contact` edge whose label is the slot
 * (lib/objects/associations.ts); the account page rolls them up.
 * Canon suggests the Executive and the N-1 from titles; a person accepts them.
 */
import { DEAL_ROLES, type DealRole } from "./objects/registry.ts";
import { departmentOf, NONE, seniorityOf } from "./staging.ts";

export { DEAL_ROLES, type DealRole };
/** A committee slot: every role but `involved`. */
export type Slot = Exclude<DealRole, "involved">;
export const SLOTS: readonly Slot[] = DEAL_ROLES.filter((r): r is Slot => r !== "involved");

export const ROLE_LABEL: Record<DealRole, string> = {
  executive: "Executive", n1: "N-1", champion: "Champion", user: "User",
  procurement: "Procurement", security: "Security", signer: "Signer", involved: "Involved",
};

const RANK: Record<string, number> = { founder: 5, owner: 5, cxo: 5, vp: 4, head: 3, director: 3, partner: 3, manager: 2 };
const LEVEL: Record<string, string> = {
  founder: "Founder", owner: "Owner", cxo: "C-level", vp: "VP", head: "Head", director: "Director", partner: "Partner", manager: "Manager",
};

/** How senior a title reads, from 1 (no level found) to 5 (C-level, founder, owner). */
export const seniorityRank = (title: string | undefined) => RANK[seniorityOf(title)] ?? 1;
/** The level a title names ("VP", "Director"), or "" when it names none. */
export const seniorityLabel = (title: string | undefined) => LEVEL[seniorityOf(title)] ?? "";

export type Person = { id: string; fullName: string; title?: string };
export type Suggestion = { slot: "executive" | "n1"; contactId: string; reason: string };

/** Lowest rank an Executive can have: a director or above. */
const EXEC_MIN = 3;

const bySeniority = (a: Person, b: Person) => seniorityRank(b.title) - seniorityRank(a.title) || a.fullName.localeCompare(b.fullName);

/**
 * Canon's picks for the empty Executive and N-1 slots. The Executive is the
 * most senior title at the company. The N-1 is the most senior person below
 * them, in the Executive's department when it has one (a CEO or founder has
 * none, so anyone below counts). People already on the committee are skipped;
 * a filled Executive anchors the N-1 pick.
 */
export function suggestCommittee(people: readonly Person[], filled: { executive?: string; n1?: string }, onCommittee: ReadonlySet<string>): Suggestion[] {
  const out: Suggestion[] = [];
  const free = people.filter((p) => !onCommittee.has(p.id)).sort(bySeniority);
  let exec = filled.executive ? people.find((p) => p.id === filled.executive) : undefined;
  if (!filled.executive) {
    const top = free[0];
    if (top && seniorityRank(top.title) >= EXEC_MIN) {
      exec = top;
      const dept = departmentOf(top.title);
      out.push({ slot: "executive", contactId: top.id, reason: dept === NONE ? "Most senior title at the company" : `Most senior ${dept} title at the company` });
    }
  }
  if (!filled.n1 && exec) {
    const execRank = seniorityRank(exec.title);
    const dept = departmentOf(exec.title);
    const below = free.filter((p) => p.id !== exec.id && seniorityRank(p.title) < execRank && seniorityRank(p.title) >= 2);
    const same = dept === NONE ? below : below.filter((p) => departmentOf(p.title) === dept);
    const pick = same[0];
    if (pick) {
      out.push({ slot: "n1", contactId: pick.id, reason: dept === NONE ? `Most senior person below ${exec.fullName}` : `Most senior ${dept} person below ${exec.fullName}` });
    }
  }
  return out;
}
