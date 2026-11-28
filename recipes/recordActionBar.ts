export function splitRecordActions<T>(actions: readonly T[]) {
  return { buttons: actions.slice(0, 6), overflow: actions.slice(6) };
}
