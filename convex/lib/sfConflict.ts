// Convex-facing re-export of the pure Salesforce sync conflict resolver.
// The implementation lives in the package so the engine, tests and Convex
// share one definition.
export {
  normalizeValue,
  resolveField,
  valuesEqual,
  type Decision,
  type Direction,
  type ResolveInput,
} from "../../engine/src/sync/salesforceSync/resolver.ts";
