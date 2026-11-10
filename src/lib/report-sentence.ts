/** "a", "a and b", "a, b and c". */
const list = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * A report read as one line, the preview's subtitle: what it measures, by what, and which fields filter it
 * ("Sum of Amount and Count by Stage and Close date (quarter) · filtered by Closed").
 */
export function reportSentence(measures: readonly string[], keys: readonly string[], filters: readonly string[]): string {
  const what = list(measures.length ? measures : ["Count"]);
  return `${what}${keys.length ? ` by ${list(keys)}` : ""}${filters.length ? ` · filtered by ${list(filters)}` : ""}`;
}
