export type GtmReadinessRow = {
  noun: string;
  required: boolean;
  relevant: boolean;
  configured: boolean;
  lifecycle: string;
  signals: Record<string, unknown>;
  nextActions: string[];
};

export function isReadinessRow(value: unknown): value is GtmReadinessRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.noun === "string" &&
    typeof row.required === "boolean" &&
    typeof row.relevant === "boolean" &&
    typeof row.configured === "boolean" &&
    typeof row.lifecycle === "string" &&
    Boolean(row.signals) &&
    typeof row.signals === "object" &&
    !Array.isArray(row.signals) &&
    Array.isArray(row.nextActions)
  );
}

export function summarizeReadiness(rows: Array<readonly [string, unknown]>) {
  const validRows = rows.filter((entry): entry is readonly [string, GtmReadinessRow] => isReadinessRow(entry[1]));
  return {
    total: rows.length,
    required: validRows.filter(([, row]) => row.required).length,
    relevant: validRows.filter(([, row]) => row.relevant).length,
    configured: validRows.filter(([, row]) => row.configured).length,
    missingRequired: validRows.filter(([, row]) => row.required && !row.configured).length,
  };
}

export function readinessNames(
  rows: Array<readonly [string, unknown]>,
  predicate: (row: GtmReadinessRow) => boolean,
) {
  return rows
    .filter(([, row]) => isReadinessRow(row) && predicate(row))
    .map(([noun]) => noun);
}
