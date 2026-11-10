import type { Icp } from "../../../engine/src/icp.ts";
import { freePopulationRequest } from "../../../modules/kernel/freePopulation.ts";
import { icpToQuickEnrich } from "../quickenrich.ts";

export function freePopulationQuery(raw: string) {
  const q = freePopulationRequest(raw);
  const sized = q.employeeMin !== undefined || q.employeeMax !== undefined;
  const band = q.employeeMax !== undefined ? `${q.employeeMin ?? 1}-${q.employeeMax}` : `${q.employeeMin ?? 1}+`;
  return icpToQuickEnrich({ name: "market", persona: { jobLevels: q.buyer.levels, departments: q.buyer.departments, titleKeywords: q.buyer.titles }, firmographics: { industries: q.industries, geos: q.countries, employeeBands: sized ? [band] : q.employeeBands ?? [] } } as Icp);
}
