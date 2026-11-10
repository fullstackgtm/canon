/**
 * Telnyx Call Control (API v2) adapter for the dialer (docs/dialer.md). Canon
 * holds one platform key and one Call Control application; every call it
 * places names that application, so Telnyx sends its webhooks to
 * `/telnyx/webhook`.
 *
 * The key goes only in the Authorization header. Errors carry the HTTP status
 * and Telnyx's first error code, never the response body or the key. The
 * fetch is injected, so tests run against a fake HTTP layer.
 *
 * Pure: no database access, no Node-only imports.
 */

export class TelnyxError extends Error {
  readonly status: number;
  /** Telnyx's first error `code`, e.g. "90018" (call already ended), when it sent one. */
  readonly code: string | null;
  /** Telnyx's first error title, e.g. "Destination not allowed": its reason, in words. Never the request or the key. */
  readonly title: string | null;
  constructor(status: number, code: string | null, title: string | null = null) {
    // 401 is a bad key. 403 is usually not: Telnyx refuses a call it won't place (account level, destination,
    // caller ID), so its own title says why.
    super(
      status === 401
        ? "Telnyx rejected Canon's API key (HTTP 401)."
        : `Telnyx refused (HTTP ${status}${code ? `, code ${code}` : ""}${title ? `: ${title}` : ""}).`,
    );
    this.name = "TelnyxError";
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export type TelnyxConfig = { apiKey: string; connectionId: string; fetchImpl?: typeof fetch };

/** Rides through Telnyx as base64 `client_state` and comes back on every webhook for the leg. */
export type LegState = { k: "agent"; s: string } | { k: "contact"; c: string };

export function encodeLegState(state: LegState): string {
  return btoa(JSON.stringify(state));
}

export function decodeLegState(raw: unknown): LegState | null {
  if (typeof raw !== "string" || !raw || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(atob(raw)) as { k?: unknown; s?: unknown; c?: unknown };
    if (parsed.k === "agent" && typeof parsed.s === "string") return { k: "agent", s: parsed.s };
    if (parsed.k === "contact" && typeof parsed.c === "string") return { k: "contact", c: parsed.c };
    return null;
  } catch {
    return null;
  }
}

/** A phone number in E.164, or null. Ten digits are taken as North American. */
export function toE164(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("00") && digits.length >= 10 && digits.length <= 17) return `+${digits.slice(2)}`;
  return null;
}

const errorOf = async (response: Response): Promise<{ code: string | null; title: string | null }> => {
  try {
    const body = (await response.json()) as { errors?: { code?: unknown; title?: unknown; detail?: unknown }[] };
    const first = body.errors?.[0];
    const code = typeof first?.code === "string" && /^\w{1,20}$/.test(first.code) ? first.code : null;
    const words = [first?.title, first?.detail].find((t): t is string => typeof t === "string" && t.trim() !== "");
    const title = words ? words.replace(/[^\w .,:;'()/+-]/g, "").trim().slice(0, 160) || null : null;
    return { code, title };
  } catch {
    return { code: null, title: null };
  }
};

export type DialParams = {
  to: string;
  from: string;
  state: LegState;
  timeoutSecs?: number;
  /** Answering machine detection on the callee's leg (docs/dialer.md, voicemail). */
  detectMachine?: boolean;
};

export type TelnyxClient = {
  /** Places a call; returns its call_control_id. */
  dial(params: DialParams): Promise<string>;
  speak(legId: string, text: string, state: LegState, commandId?: string): Promise<void>;
  hangup(legId: string): Promise<void>;
  /**
   * Bridge the rep's leg to a contact who answered. `park_after_unbridge` is set on the rep's leg, so when
   * the contact hangs up the rep's call is parked, not hung up, ready for the next contact.
   */
  bridge(agentLegId: string, contactLegId: string): Promise<void>;
  /** Dual-channel mp3 with Telnyx's post-call transcription; the recording webhooks carry `state`. */
  recordStart(legId: string, state: LegState, commandId: string): Promise<void>;
  /** A fresh download URL for a recording (Telnyx's expire in about ten minutes). */
  recordingUrl(recordingId: string): Promise<string | null>;
  /** A telephony credential on the WebRTC credential connection: one per rep, for browser audio. */
  createCredential(credentialConnectionId: string, name: string): Promise<{ id: string; sipUsername: string }>;
  deleteCredential(credentialId: string): Promise<void>;
  /** A short-lived (about a day) login token the browser SDK signs in with; it never sees Canon's key. */
  credentialToken(credentialId: string): Promise<string>;
};

/** Where Telnyx rings a credential's browser client. */
export const sipUriFor = (sipUsername: string) => `sip:${sipUsername}@sip.telnyx.com`;

const BASE = "https://api.telnyx.com/v2";

export function createTelnyxClient(config: TelnyxConfig): TelnyxClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const send = async (method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>): Promise<Response> => {
    const response = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const { code, title } = await errorOf(response);
      throw new TelnyxError(response.status, code, title);
    }
    return response;
  };
  const call = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<unknown> => {
    const response = await send(method, path, body);
    try {
      return await response.json();
    } catch {
      return null;
    }
  };
  const action = (legId: string, name: string, body: Record<string, unknown>) =>
    call("POST", `/calls/${encodeURIComponent(legId)}/actions/${name}`, body);

  return {
    async dial(p) {
      const res = (await call("POST", "/calls", {
        connection_id: config.connectionId,
        to: p.to,
        from: p.from,
        client_state: encodeLegState(p.state),
        timeout_secs: p.timeoutSecs ?? 30,
        // detect_beep: the verdict, then `call.machine.greeting.ended` at the beep, when a voicemail can start.
        ...(p.detectMachine ? { answering_machine_detection: "detect_beep" } : {}),
      })) as { data?: { call_control_id?: unknown } } | null;
      const id = res?.data?.call_control_id;
      if (typeof id !== "string" || !id) throw new TelnyxError(502, "no_call_control_id");
      return id;
    },
    async speak(legId, text, state, commandId) {
      await action(legId, "speak", { payload: text, voice: "female", language: "en-US", client_state: encodeLegState(state), ...(commandId ? { command_id: commandId } : {}) });
    },
    async hangup(legId) {
      await action(legId, "hangup", {});
    },
    async bridge(agentLegId, contactLegId) {
      await action(agentLegId, "bridge", { call_control_id: contactLegId, park_after_unbridge: "self" });
    },
    async recordStart(legId, state, commandId) {
      await action(legId, "record_start", {
        format: "mp3",
        channels: "dual",
        transcription: true,
        transcription_engine: "deepgram/nova-3",
        client_state: encodeLegState(state),
        command_id: commandId,
      });
    },
    async createCredential(credentialConnectionId, name) {
      const res = (await call("POST", "/telephony_credentials", { connection_id: credentialConnectionId, name })) as { data?: { id?: unknown; sip_username?: unknown } } | null;
      const id = res?.data?.id;
      const sipUsername = res?.data?.sip_username;
      if (typeof id !== "string" || typeof sipUsername !== "string" || !/^[\w.-]{1,80}$/.test(sipUsername)) throw new TelnyxError(502, "no_credential");
      return { id, sipUsername };
    },
    async deleteCredential(credentialId) {
      await send("DELETE", `/telephony_credentials/${encodeURIComponent(credentialId)}`);
    },
    async credentialToken(credentialId) {
      // The token endpoint answers with the JWT as plain text.
      const token = (await (await send("POST", `/telephony_credentials/${encodeURIComponent(credentialId)}/token`)).text()).trim();
      if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new TelnyxError(502, "no_token");
      return token;
    },
    async recordingUrl(recordingId) {
      const res = (await call("GET", `/recordings/${encodeURIComponent(recordingId)}`)) as { data?: { download_urls?: { mp3?: unknown } } } | null;
      const url = res?.data?.download_urls?.mp3;
      return typeof url === "string" && url.startsWith("https://") ? url : null;
    },
  };
}
