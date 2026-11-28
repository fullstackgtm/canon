export function canChangeRecordPath(writable: boolean, field: string | undefined, readOnlyFields: readonly string[], hasNextStage: boolean) {
  return writable && Boolean(field && !readOnlyFields.includes(field)) && hasNextStage;
}
