// GENERATED from modules/kernel/inboundMatchInput.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
/** The input of the `match.inbound` read (docs/modules.md, "Inbound matching"), checked and normalized the way Canon matches it. */
export type InboundMatchInput = { email: string; companyName?: string };

export function inboundMatchInput(input: InboundMatchInput): InboundMatchInput {
  const email = input.email.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(email)) throw new Error("Enter a valid email address.");
  if (input.companyName !== undefined && input.companyName.length > 200) throw new Error("Company name is too long.");
  return { email, ...(input.companyName?.trim() ? { companyName: input.companyName.trim() } : {}) };
}
