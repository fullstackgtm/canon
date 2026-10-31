export interface GtmPlanExportInput {
  _id: string;
  name: string;
  fiscalYear: string;
  quarter?: string;
  status: string;
  objectives?: unknown[];
  keyResults?: unknown[];
  initiatives?: unknown[];
  createdAt?: number;
  updatedAt?: number;
}

export interface GtmPlanOverviewExportRow {
  planId: string;
  planName: string;
  fiscalYear: string;
  quarter: string;
  status: string;
  objectiveCount: number;
  keyResultCount: number;
  initiativeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GtmPlanObjectiveExportRow {
  planId: string;
  planName: string;
  fiscalYear: string;
  quarter: string;
  planStatus: string;
  objectiveId: string;
  title: string;
  description: string;
  owner: string;
  status: string;
  keyResultCount: number;
}

export interface GtmPlanKeyResultExportRow {
  planId: string;
  planName: string;
  fiscalYear: string;
  quarter: string;
  planStatus: string;
  keyResultId: string;
  objectiveId: string;
  objectiveTitle: string;
  title: string;
  targetValue: number | "";
  currentValue: number | "";
  unit: string;
  progressPercent: number | "";
}

export interface GtmPlanInitiativeExportRow {
  planId: string;
  planName: string;
  fiscalYear: string;
  quarter: string;
  planStatus: string;
  initiativeId: string;
  objectiveId: string;
  objectiveTitle: string;
  title: string;
  description: string;
  owner: string;
  startDate: string;
  endDate: string;
  status: string;
}

export function buildGtmPlanOverviewExportRows(
  plans: GtmPlanExportInput[],
): GtmPlanOverviewExportRow[] {
  return plans.map((plan) => ({
    planId: plan._id,
    planName: plan.name,
    fiscalYear: plan.fiscalYear,
    quarter: plan.quarter ?? "Full Year",
    status: plan.status,
    objectiveCount: asArray(plan.objectives).length,
    keyResultCount: asArray(plan.keyResults).length,
    initiativeCount: asArray(plan.initiatives).length,
    createdAt: formatExportTimestamp(plan.createdAt),
    updatedAt: formatExportTimestamp(plan.updatedAt),
  }));
}

export function buildGtmPlanObjectiveExportRows(
  plan: GtmPlanExportInput,
): GtmPlanObjectiveExportRow[] {
  const keyResults = asArray(plan.keyResults).map(asRecord);

  return asArray(plan.objectives).flatMap((objective) => {
    const record = asRecord(objective);
    const objectiveId = stringValue(record.id);
    if (!objectiveId) return [];
    return [{
      planId: plan._id,
      planName: plan.name,
      fiscalYear: plan.fiscalYear,
      quarter: plan.quarter ?? "Full Year",
      planStatus: plan.status,
      objectiveId,
      title: stringValue(record.title),
      description: stringValue(record.description),
      owner: stringValue(record.owner),
      status: stringValue(record.status),
      keyResultCount: keyResults.filter(
        (keyResult) => stringValue(keyResult.id) && stringValue(keyResult.objectiveId) === objectiveId,
      ).length,
    }];
  });
}

export function buildGtmPlanKeyResultExportRows(
  plan: GtmPlanExportInput,
): GtmPlanKeyResultExportRow[] {
  const objectiveTitlesById = new Map(
    asArray(plan.objectives).flatMap((objective) => {
      const record = asRecord(objective);
      const id = stringValue(record.id);
      return id ? [[id, stringValue(record.title)] as const] : [];
    }),
  );

  return asArray(plan.keyResults).flatMap((keyResult) => {
    const record = asRecord(keyResult);
    const keyResultId = stringValue(record.id);
    const objectiveId = stringValue(record.objectiveId);
    if (!keyResultId || !objectiveId) return [];
    const targetValue = numberValue(record.targetValue);
    const currentValue = numberValue(record.currentValue);
    return [{
      planId: plan._id,
      planName: plan.name,
      fiscalYear: plan.fiscalYear,
      quarter: plan.quarter ?? "Full Year",
      planStatus: plan.status,
      keyResultId,
      objectiveId,
      objectiveTitle: objectiveTitlesById.get(objectiveId) ?? "",
      title: stringValue(record.title),
      targetValue: targetValue ?? "",
      currentValue: currentValue ?? "",
      unit: stringValue(record.unit),
      progressPercent:
        targetValue !== undefined && currentValue !== undefined
          ? targetValue === 0
            ? (currentValue === 0 ? 100 : "")
            : Math.round((currentValue / targetValue) * 100)
          : "",
    }];
  });
}

export function buildGtmPlanInitiativeExportRows(
  plan: GtmPlanExportInput,
): GtmPlanInitiativeExportRow[] {
  const objectiveTitlesById = new Map(
    asArray(plan.objectives).flatMap((objective) => {
      const record = asRecord(objective);
      const id = stringValue(record.id);
      return id ? [[id, stringValue(record.title)] as const] : [];
    }),
  );

  return asArray(plan.initiatives).map((initiative) => {
    const record = asRecord(initiative);
    const objectiveId = stringValue(record.objectiveId);
    return {
      planId: plan._id,
      planName: plan.name,
      fiscalYear: plan.fiscalYear,
      quarter: plan.quarter ?? "Full Year",
      planStatus: plan.status,
      initiativeId: stringValue(record.id),
      objectiveId,
      objectiveTitle: objectiveTitlesById.get(objectiveId) ?? "",
      title: stringValue(record.title),
      description: stringValue(record.description),
      owner: stringValue(record.owner),
      startDate: stringValue(record.startDate),
      endDate: stringValue(record.endDate),
      status: stringValue(record.status),
    };
  });
}

export function getGtmPlanExportBaseName(plan: GtmPlanExportInput): string {
  const fiscalYear = slugifyExportSegment(plan.fiscalYear || "fiscal-year");
  const quarter = slugifyExportSegment(plan.quarter ?? "full-year");
  const name = slugifyExportSegment(plan.name || "gtm-plan");
  return `gtm-plan-${fiscalYear}-${quarter}-${name}`;
}

export function formatExportTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Date(value).toISOString();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function slugifyExportSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "gtm-plan";
}
