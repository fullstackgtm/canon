/**
 * What a Convex call's failure means to whoever made it: an agent over /mcp,
 * a script on /api/v1, or the dashboard.
 *
 * ConvexHttpClient errors arrive as "[Request ID: x] Server Error\nUncaught
 * ConvexError: msg\n    at frame". Argument validation failures are written
 * for the function's author ("Consider wrapping the field validator in
 * v.optional"), and a plain Error from a production deployment is redacted to
 * "Server Error". Callers need the field, what it takes, and what to do next.
 */
import { ConvexError } from "convex/values";

export type ConvexErrorKind =
  /** A ConvexError: its message was written for the caller. */
  | "rejected"
  /** The arguments did not match the function's validator. */
  | "invalid_argument"
  /** Anything else; production redacts the message. */
  | "internal";

export type ExplainedConvexError = {
  kind: ConvexErrorKind;
  message: string;
  /** The argument at fault, as a dotted path ("sort.dir"), for invalid_argument. */
  field?: string;
  requestId?: string;
  /** ConvexError object data (for example `{ code: "ARTIFACT_CONFLICT", currentRevision }`). */
  data?: Record<string, unknown>;
};

const REQUEST_ID = /\[Request ID: ([^\]]+)\]/;

/** The message without the request id, "Server Error", "Uncaught", stack frames and "Called by client". */
export function plainConvexMessage(raw: string): string {
  return raw
    .replace(/^\[CONVEX [^\]]*\]\s*/, "")
    .replace(/^\[Request ID: [^\]]*\]\s*/, "")
    .replace(/^Server Error\s*/, "")
    .replace(/^Uncaught (ConvexError: |Error: )?/, "")
    .replace(/\n\s+at [\s\S]*$/, "")
    .replace(/\s+Called by client$/, "")
    .trim();
}

/** The comma-separated arguments of a validator call, split at depth zero. */
function members(inner: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < inner.length; i++) {
    if ("({[".includes(inner[i])) depth++;
    else if (")}]".includes(inner[i])) depth--;
    else if (inner[i] === "," && depth === 0) { out.push(inner.slice(from, i).trim()); from = i + 1; }
  }
  return [...out, inner.slice(from).trim()].filter(Boolean);
}

/** "v.id(\"deals\")" -> what a caller should send instead. */
function expected(validator: string): string {
  if (/^v\.id\("\w+"\)$/.test(validator)) return "an id returned by a Canon list, find or create call";
  if (/^v\.(float64|int64|number)\(\)$/.test(validator)) return "a number";
  if (validator === "v.string()") return "a string";
  if (validator === "v.boolean()") return "true or false";
  if (validator === "v.null()") return "null";
  const literal = validator.match(/^v\.literal\((.+)\)$/);
  if (literal) return literal[1];
  if (validator.startsWith("v.array(")) return "a list";
  if (validator.startsWith("v.object(") || validator.startsWith("v.record(")) return "an object";
  const union = validator.match(/^v\.union\(([\s\S]*)\)$/);
  if (union) {
    const options = [...new Set(members(union[1]).map(expected))];
    return options.every((o) => /^["\d-]/.test(o)) ? `one of ${options.join(", ")}` : options.join(" or ");
  }
  return "a different value";
}

/** The validator text of `name` inside the object validator, balancing parentheses. */
function validatorOf(text: string, name: string): string | undefined {
  const start = text.match(new RegExp(`[{,]\\s*${name}: v\\.`))?.index;
  if (start === undefined) return undefined;
  const from = text.indexOf("v.", start);
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(from, i + 1);
  }
  return undefined;
}

function explainArgumentError(text: string): { message: string; field?: string } {
  const path = text.match(/^Path: \.?(.+)$/m)?.[1];
  const missing = text.match(/missing the required field `([^`]+)`/)?.[1];
  if (missing) {
    const field = path ? `${path}.${missing}` : missing;
    const validator = validatorOf(text, missing);
    return { field, message: `${field} is required${validator ? ` (${expected(validator)})` : ""}` };
  }
  const extra = text.match(/extra field `([^`]+)`/)?.[1];
  if (extra) {
    const field = path ? `${path}.${extra}` : extra;
    const allowed = [...(text.match(/^Validator: v\.object\(\{([\s\S]*)\}\)$/m)?.[1] ?? "").matchAll(/(?:^|, )(\w+): /g)].map((m) => m[1]);
    return { field, message: `${field} is not a recognized argument${allowed.length ? `; allowed: ${allowed.join(", ")}` : ""}` };
  }
  // Convex prints every number as a float ("12345.0"); show what the caller sent.
  const value = text.match(/^Value: (.+)$/m)?.[1]?.replace(/^(-?\d+)\.0$/, "$1");
  const validator = text.match(/^Validator: (.+)$/m)?.[1];
  if (path && validator) return { field: path, message: `${path} must be ${expected(validator)}${value ? ` (got ${value})` : ""}` };
  return { message: "The arguments do not match what this call takes" };
}

export function explainConvexError(error: unknown): ExplainedConvexError {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const requestId = raw.match(REQUEST_ID)?.[1];
  const withId = <T extends ExplainedConvexError>(e: T): T => (requestId ? { ...e, requestId } : e);
  if (error instanceof ConvexError) {
    const data = error.data as unknown;
    if (typeof data === "string") return withId({ kind: "rejected", message: data });
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      const message = typeof d.message === "string" ? d.message : typeof d.code === "string" ? d.code : plainConvexMessage(raw);
      return withId({ kind: "rejected", message, data: d });
    }
  }
  if (/ArgumentValidationError|Validator error|Value does not match validator/.test(raw)) {
    return withId({ kind: "invalid_argument", ...explainArgumentError(raw) });
  }
  const plain = plainConvexMessage(raw);
  if (/^Uncaught ConvexError: /m.test(raw.replace(/^\[Request ID: [^\]]*\]\s*Server Error\s*/, ""))) {
    return withId({ kind: "rejected", message: plain });
  }
  return withId({
    kind: "internal",
    message: plain && plain !== "Server Error"
      ? plain
      : `Canon hit an unexpected error${requestId ? ` (request ${requestId})` : ""}. Retry once; if it fails again, report the request id.`,
  });
}
