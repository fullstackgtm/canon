export type VisitFunction = "visits:visitOpen" | "visits:visitPage" | "visits:visitOp" | "visits:visitTransition" | "visits:visitUpload" | "visits:visitFile" | "visits:visitRequestCode" | "visits:visitVerifyCode";
export type VisitOpenArgs = {
  tokenHash: string;
  newSessionHash: string;
  sessions: Array<{ publicId: string; sessionHash: string }>;
  name?: string;
  email?: string;
};
export type VisitPageArgs = { publicId: string; sessionHash: string; path?: string };
export type VisitorWrite =
  | { kind: "op"; op: string; key?: string; expect?: number; data?: Record<string, unknown>; unset?: string[] }
  | { kind: "transition"; machine: string; transition: string; key: string; expect: number; args?: Record<string, unknown> };
export type VisitOpArgs = { publicId: string; sessionHash: string } & Omit<Extract<VisitorWrite, { kind: "op" }>, "kind">;
export type VisitTransitionArgs = { publicId: string; sessionHash: string } & Omit<Extract<VisitorWrite, { kind: "transition" }>, "kind">;
export type VisitorUploadTarget =
  | { kind: "op"; op: string; key?: string; expect?: number; field: string }
  | { kind: "transition"; machine: string; transition: string; key: string; expect: number; field: string };
export type VisitUploadArgs = { publicId: string; sessionHash: string; target: VisitorUploadTarget; file: import("./visitorFiles.ts").VisitorFileMetadata };
export type VisitFileArgs = { publicId: string; sessionHash: string; file: string };
export type VisitRequestCodeArgs = { publicId: string; sessionHash: string; email: string };
export type VisitVerifyCodeArgs = { publicId: string; sessionHash: string; code: string };
export type VisitUploadTicket = { ticket: string; secret: string; url: string };
export type VisitArgs = VisitOpenArgs | VisitPageArgs | VisitOpArgs | VisitTransitionArgs | VisitUploadArgs | VisitFileArgs | VisitRequestCodeArgs | VisitVerifyCodeArgs;
export type VisitorIdentity = { id: string; name?: string; email?: string; label: string; verified: boolean };
export type VisitFailure = { ok: false; status: 403 | 429; identityRequired?: boolean; verificationRequired?: boolean };
export type VisitResult<T> = { ok: true; value: T } | VisitFailure;
export const VISIT_DEAD = "This link has expired or was turned off";
export const PUBLIC_GRANT = /^[A-Za-z0-9_-]{22}$/;
export const VISIT_SECRET = /^[A-Za-z0-9_-]{43}$/;
export const VISIT_HASH = /^[a-f0-9]{64}$/;

export function visitorValueFits(value: unknown, field = ""): boolean {
  if (typeof value === "string") {
    if (value.length > 5000) return false;
    if (value && /(?:^|_)(?:url|href|link)$|(?:Url|URL|Href|Link)$/.test(field)) {
      try { return new URL(value).protocol === "https:"; } catch { return false; }
    }
    return true;
  }
  return !value || typeof value !== "object" || Object.entries(value).every(([key, v]) => visitorValueFits(v, key));
}
