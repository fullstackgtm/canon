// A leading + or - is left alone only on a number or a phone number (-12.5, +1 (555) 010-0000): `-2+3+cmd|...` still runs.
const FORMULA_PREFIX_PATTERN = /^(?:[=@\t\r\n]|[+\-](?![\d\s.()-]*$))/;
const LEADING_WHITESPACE_FORMULA_PATTERN = /^\s+(?:[=@]|[+\-](?![\d\s.()-]*$))/;

export function serializeCsvRows(rows: unknown[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function escapeCsvCell(value: unknown): string {
  const rawText = csvText(value);
  const text = shouldNeutralizeCsvValue(value)
    ? neutralizeSpreadsheetFormula(rawText)
    : rawText;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function neutralizeSpreadsheetFormula(text: string): string {
  if (
    FORMULA_PREFIX_PATTERN.test(text) ||
    LEADING_WHITESPACE_FORMULA_PATTERN.test(text)
  ) {
    return `'${text}`;
  }
  return text;
}

function shouldNeutralizeCsvValue(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value);
}

function csvText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(csvText).join("; ");
  return "";
}
