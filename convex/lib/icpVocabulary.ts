import { DEPARTMENT, classifyTitle } from "../../services/record-service/src/titles.ts";

export const EMPLOYEE_BANDS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"] as const;

export const LEVELS: Array<{ value: string; label: string }> = [
  { value: "cxo", label: "C-suite" }, { value: "vp", label: "VP" }, { value: "head", label: "Head" },
  { value: "director", label: "Director" }, { value: "manager", label: "Manager" }, { value: "owner", label: "Owner" },
  { value: "founder", label: "Founder" }, { value: "partner", label: "Partner" }, { value: "senior", label: "Senior" },
];

export const DEPARTMENTS = ["Sales", "Marketing", "Revenue operations", "Operations", "Finance", "Customer success", "Business development", "Engineering", "Product", "IT", "HR", "Legal"];

/**
 * Departments in the form's spelling, de-duplicated: "finance" is Finance, and a name the title tables read as one
 * ("accounting", "sales operations") is that one, so every department an ICP counts shows as a chip. Others stay as written.
 */
export function canonDepartments(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean).map((v) =>
    DEPARTMENTS.find((d) => d.toLowerCase() === v.toLowerCase()) ?? classifyTitle(DEPARTMENT, v) ?? v))];
}

/** ISO codes the ICP mappings know, with display names. */
export const COUNTRIES: Array<{ value: string; label: string }> = [
  ["us", "United States"], ["ca", "Canada"], ["gb", "United Kingdom"], ["ie", "Ireland"], ["de", "Germany"], ["fr", "France"],
  ["nl", "Netherlands"], ["es", "Spain"], ["it", "Italy"], ["se", "Sweden"], ["ch", "Switzerland"], ["au", "Australia"],
  ["nz", "New Zealand"], ["sg", "Singapore"], ["in", "India"], ["jp", "Japan"], ["il", "Israel"], ["br", "Brazil"], ["mx", "Mexico"],
].map(([value, label]) => ({ value, label }));
