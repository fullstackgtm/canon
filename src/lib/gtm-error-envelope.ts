export type GtmErrorCode =
  | "UNKNOWN_COMMAND"
  | "USER_INPUT"
  | "SAFETY_BLOCK"
  | "ENVIRONMENT"
  | "UPSTREAM"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_ACTION"
  | "CONFLICT";

export type GtmErrorEnvelope = {
  ok: false;
  error: {
    code: GtmErrorCode;
    message: string;
    hints: string[];
  };
};

export const gtmExitCodes = {
  success: 0,
  userInputError: 1,
  safetyBlock: 2,
  toolEnvironmentError: 3,
  upstreamFailure: 4,
  conflict: 5,
} as const;

export function gtmErrorEnvelope(
  code: GtmErrorCode,
  message: string,
  hints: string[] = [],
): GtmErrorEnvelope {
  return { ok: false, error: { code, message, hints } };
}

export function gtmErrorStatus(code: GtmErrorCode) {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "UNSUPPORTED_ACTION":
    case "UNKNOWN_COMMAND":
    case "USER_INPUT":
      return 400;
    case "SAFETY_BLOCK":
      return 403;
    case "CONFLICT":
      return 409;
    case "ENVIRONMENT":
    case "UPSTREAM":
    default:
      return 500;
  }
}
