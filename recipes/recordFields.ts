type RecordField = { apiName: string; fieldId: string; hidden?: boolean; archivedAt?: number };

export function visibleRecordFields<F extends RecordField>(fields: readonly F[], names: readonly string[]): F[] {
  const visible = fields.filter((field) => !field.hidden && field.archivedAt === undefined);
  return [...new Set(names.flatMap((name) => {
    const field = visible.find((candidate) => candidate.apiName === name || candidate.fieldId === name);
    return field ? [field] : [];
  }))];
}

export function canEditRecordField(writable: boolean, versioned: boolean, field: RecordField, readOnlyFields: readonly string[]): boolean {
  return writable && versioned && !field.hidden && field.archivedAt === undefined && !readOnlyFields.includes(field.apiName);
}
