import { INDUSTRIES } from "../../services/record-service/src/industries.ts";
import { icpGeosToIso } from "../../convex/lib/icpGeography.ts";

/** One explicit free search. Numeric bounds stay intact until the existing provider mapper runs. */
export type FreePopulationQuery = {
  industries: string[];
  countries: string[];
  employeeMin?: number;
  employeeMax?: number;
  employeeBands?: string[];
  buyer: { levels: string[]; departments: string[]; titles: string[] };
};
const industrySet = new Set(INDUSTRIES.map((i) => i.key));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 120 && s === s.trim());

export function freePopulationRequest(raw: unknown): FreePopulationQuery {
  if (typeof raw !== "string" || raw.length > 10000) throw new Error("A free search requires a bounded JSON query.");
  const q: unknown = JSON.parse(raw);
  if (!object(q) || Object.keys(q).some((k) => !["industries", "countries", "employeeMin", "employeeMax", "employeeBands", "buyer"].includes(k)) || !strings(q.industries, 3) || !q.industries.length || !q.industries.every((s) => industrySet.has(s)) || !strings(q.countries, 50)) throw new Error("Choose valid industries and countries for the free search.");
  for (const field of ["employeeMin", "employeeMax"] as const) if (q[field] !== undefined && (!Number.isSafeInteger(q[field]) || Number(q[field]) < 1 || Number(q[field]) > 1_000_000_000)) throw new Error("Employee bounds must be positive integers.");
  if (q.employeeMin !== undefined && q.employeeMax !== undefined && Number(q.employeeMin) > Number(q.employeeMax)) throw new Error("Employee bounds are reversed.");
  if (q.employeeBands !== undefined && (!strings(q.employeeBands, 20) || !q.employeeBands.every((b) => {
    const band = /^(\d+)(?:-(\d+)|\+)$/.exec(b);
    if (!band) return false;
    const min = Number(band[1]), max = band[2] ? Number(band[2]) : min;
    return Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 1 && max >= min && max <= 1_000_000_000;
  }))) throw new Error("Invalid employee bands.");
  if (!object(q.buyer) || Object.keys(q.buyer).sort().join() !== "departments,levels,titles" || !strings(q.buyer.levels, 20) || !strings(q.buyer.departments, 30) || !strings(q.buyer.titles, 40)) throw new Error("Invalid buyer criteria.");
  if (q.countries.length && q.countries.some((c) => !icpGeosToIso([c]).length)) throw new Error("Unknown country in the free search.");
  return {
    industries: q.industries, countries: q.countries,
    ...(typeof q.employeeMin === "number" ? { employeeMin: q.employeeMin } : {}),
    ...(typeof q.employeeMax === "number" ? { employeeMax: q.employeeMax } : {}),
    ...(strings(q.employeeBands, 20) ? { employeeBands: q.employeeBands } : {}),
    buyer: { levels: q.buyer.levels, departments: q.buyer.departments, titles: q.buyer.titles },
  };
}

export function marketSampleRequest(args: Record<string, unknown>): string[] {
  if (Object.keys(args).join() !== "queries" || !Array.isArray(args.queries) || args.queries.length > 5) throw new Error("market.sample accepts at most five explicit free searches.");
  return args.queries.map((q) => JSON.stringify(freePopulationRequest(q)));
}
