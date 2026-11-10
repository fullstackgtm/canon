/**
 * Whether this deployment can read an archive's data (convex/workspaceImport.ts): by the data epochs of
 * scripts/selfhost/data-contract.json, as selfhost:restore checks a backup, and by the record service contract its
 * register was exported under.
 */
import { parseContract, planData } from "../../scripts/selfhost/releases.mjs";
import dataContract from "../../scripts/selfhost/data-contract.json";
import { contractAtLeast, REGISTER_EXPORT_VERSION } from "../../convex/lib/workspaceArchive/register.ts";

/** Why this deployment can't read data from the archive's source: its data epoch, or its register's export format. */
export function sourceRefusals(source: { dataEpoch: number; recordContract: string | null }, contractText = JSON.stringify(dataContract)): string[] {
  const contract = parseContract(contractText);
  const why: string[] = [];
  if (source.dataEpoch > contract.epoch) why.push(`The archive's data is at epoch ${source.dataEpoch}, newer than this deployment reads (${contract.epoch}). Update this deployment first.`);
  else {
    const [plan] = planData({ epoch: source.dataEpoch, minEpoch: 0, migrations: [] }, [{ name: "this deployment", contract }]);
    if (!plan.safe) why.push(`The archive's data is at epoch ${source.dataEpoch}, older than this deployment reads (${contract.minEpoch}). Export it again from an updated source.`);
  }
  if (source.recordContract !== null && !contractAtLeast(source.recordContract, REGISTER_EXPORT_VERSION)) why.push(`The archive's register came from record service ${source.recordContract}, older than import reads (${REGISTER_EXPORT_VERSION}).`);
  return why;
}

