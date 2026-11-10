/**
 * Unipile (API v1) adapter for the LinkedIn and Gmail accounts our users
 * connect (docs/linkedin-cadences.md, docs/gmail-sending.md). Canon holds one platform key; every call names
 * the user's Unipile `account_id`. Canon never sees a LinkedIn cookie, a
 * password or a Google token: the login happens on Unipile's hosted page.
 *
 * The key goes only in the X-API-KEY header. Errors carry the HTTP status and
 * Unipile's error type, never the response body or the key. The fetch is
 * injected, so tests run against a fake HTTP layer.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { Tier } from "./limits.ts";

export class UnipileError extends Error {
  readonly status: number;
  /** Unipile's error `type`, e.g. "errors/cannot_resend_yet", when it sent one. */
  readonly type: string | null;
  constructor(status: number, type: string | null) {
    super(
      status === 401 || status === 403
        ? `Unipile rejected Canon's API key (HTTP ${status}).`
        : status === 429
          ? "LinkedIn is rate limiting this account (HTTP 429)."
          : `Unipile request failed (HTTP ${status}${type ? `, ${type}` : ""}).`,
    );
    this.name = "UnipileError";
    this.status = status;
    this.type = type;
  }
}

export type UnipileConfig = { apiKey: string; dsn: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number };
export type UnipileMailboxEmail = {
  to: string; subject: string; html: string; idempotencyKey: string;
  headers: { listUnsubscribe: string; listUnsubscribePost: "List-Unsubscribe=One-Click" } | null;
};
const MAIL_DEFINITIVE_HTTP = new Set([400, 401, 403, 404, 429]);
const MAIL_DEFINITIVE_422 = new Set(["errors/invalid_account", "errors/invalid_recipient", "errors/invalid_message", "errors/invalid_headers", "errors/send_as_denied", "errors/sender_rejected", "errors/recipient_rejected"]);

/** What Canon keeps about a connected account. */
export type UnipileAccount = {
  id: string;
  /** Unipile's source status: "OK", "CREDENTIALS", "ERROR", "STOPPED", "CONNECTING", ... */
  status: string;
  name: string | null;
  publicIdentifier: string | null;
  tier: Tier;
};

const errorType = async (response: Response): Promise<string | null> => {
  try {
    const body = (await response.json()) as { type?: unknown };
    return typeof body.type === "string" && /^[\w/.-]{1,80}$/.test(body.type) ? body.type : null;
  } catch {
    return null;
  }
};

const str = (x: unknown) => (typeof x === "string" && x ? x : null);

/** Unipile lists premium features on the account; Sales Navigator outranks Premium. */
export function tierOf(features: unknown): Tier {
  const list = Array.isArray(features) ? features.map((f) => String(f).toLowerCase()) : [];
  if (list.some((f) => f.includes("sales_navigator"))) return "sales_navigator";
  if (list.some((f) => f.includes("premium") || f.includes("recruiter"))) return "premium";
  return "free";
}

export function accountOf(raw: unknown): UnipileAccount | null {
  const a = raw as { id?: unknown; type?: unknown; name?: unknown; sources?: unknown; connection_params?: { im?: { publicIdentifier?: unknown; username?: unknown; premiumFeatures?: unknown } } };
  const id = str(a?.id);
  if (!id || (a.type !== undefined && a.type !== "LINKEDIN")) return null;
  const sources = Array.isArray(a.sources) ? (a.sources as { status?: unknown }[]) : [];
  const im = a.connection_params?.im;
  return {
    id,
    status: str(sources[0]?.status) ?? "OK",
    name: str(a.name),
    publicIdentifier: str(im?.publicIdentifier) ?? str(im?.username),
    tier: tierOf(im?.premiumFeatures),
  };
}

export type Profile = {
  providerId: string;
  publicIdentifier: string | null;
  /** Already a first-degree connection of the sender. */
  connected: boolean;
  /** The sender has an invite to this person pending. */
  invitePending: boolean;
};

/** A linked mailbox: Unipile's id, whose it is (Google or Microsoft), its status and the address it sends from. */
export type UnipileMailAccount = { id: string; provider: "google" | "microsoft"; status: string; address: string; name: string | null };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A Google (Unipile type GOOGLE_OAUTH) or Microsoft (OUTLOOK) mail account with a readable address, or null for any
 * other account. Both keep the address in `connection_params.mail` (developer.unipile.com/reference/accountscontroller_getaccountbyid).
 */
export function mailAccountOf(raw: unknown): UnipileMailAccount | null {
  const a = raw as { id?: unknown; type?: unknown; name?: unknown; sources?: unknown; connection_params?: { mail?: { id?: unknown; username?: unknown } } };
  const id = str(a?.id);
  const type = typeof a?.type === "string" ? a.type.toUpperCase() : "";
  const provider = type.startsWith("GOOGLE") ? "google" : type === "OUTLOOK" ? "microsoft" : null;
  if (!id || !provider) return null;
  const mail = a.connection_params?.mail;
  const address = [str(mail?.username), str(mail?.id), str(a.name)].find((x) => x && EMAIL.test(x));
  if (!address) return null;
  const sources = Array.isArray(a.sources) ? (a.sources as { status?: unknown }[]) : [];
  const name = str(a.name);
  return { id, provider, status: str(sources[0]?.status) ?? "OK", address: address.toLowerCase(), name: name && name !== address ? name : null };
}

export function profileOf(raw: unknown): Profile | null {
  const p = raw as { provider_id?: unknown; public_identifier?: unknown; is_relationship?: unknown; network_distance?: unknown; invitation?: { type?: unknown; status?: unknown } };
  const providerId = str(p?.provider_id);
  if (!providerId) return null;
  return {
    providerId,
    publicIdentifier: str(p.public_identifier),
    connected: p.is_relationship === true || p.network_distance === "FIRST_DEGREE",
    invitePending: p.invitation?.type === "SENT" && p.invitation?.status === "PENDING",
  };
}

/** `connectedAt` is when LinkedIn made the connection (the acceptance), when Unipile says. */
export type Relation = { memberId: string | null; publicIdentifier: string | null; connectedAt: number | null };

/** A Unipile timestamp (ms, seconds or ISO text) as ms, or null. */
export function timeOf(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

async function listOrEmpty(get: () => Promise<{ items?: unknown[] }>): Promise<unknown[]> {
  try {
    const out = await get();
    return Array.isArray(out.items) ? out.items : [];
  } catch (cause) {
    if (cause instanceof UnipileError && cause.status === 404) return [];
    throw cause;
  }
}

function relationOf(raw: unknown): Relation | null {
  const r = raw as { member_id?: unknown; public_identifier?: unknown; created_at?: unknown };
  const out = { memberId: str(r?.member_id), publicIdentifier: str(r?.public_identifier), connectedAt: timeOf(r?.created_at) };
  return out.memberId || out.publicIdentifier ? out : null;
}

/**
 * A chat from the account's chat list, for conversation intake's backfill. `oneToOne` is false for group chats;
 * `skip` marks what intake never reads (spam, sponsored messages).
 */
export type ChatSummary = { id: string; attendeeProviderId: string | null; name: string | null; oneToOne: boolean; skip: boolean; at: number | null };

export function chatSummaryOf(raw: unknown): ChatSummary | null {
  const c = raw as { id?: unknown; attendee_provider_id?: unknown; name?: unknown; type?: unknown; folder?: unknown; content_type?: unknown; timestamp?: unknown };
  const id = str(c?.id);
  if (!id) return null;
  const folders = Array.isArray(c.folder) ? c.folder.map((f) => String(f).toUpperCase()) : [];
  return {
    id, attendeeProviderId: str(c.attendee_provider_id), name: str(c.name), oneToOne: Number(c.type ?? 0) === 0,
    skip: folders.some((f) => f.includes("SPAM")) || /sponsored/i.test(str(c.content_type) ?? ""), at: timeOf(c.timestamp),
  };
}

/** Someone in a chat. `self` is the account itself. */
export type ChatAttendee = { providerId: string; name: string | null; profileUrl: string | null; publicIdentifier: string | null; self: boolean };

export function chatAttendeeOf(raw: unknown): ChatAttendee | null {
  const a = raw as { provider_id?: unknown; name?: unknown; profile_url?: unknown; public_identifier?: unknown; is_self?: unknown; specifics?: { public_identifier?: unknown } };
  const providerId = str(a?.provider_id);
  if (!providerId) return null;
  return {
    providerId, name: str(a.name), profileUrl: str(a.profile_url),
    publicIdentifier: str(a.public_identifier) ?? str(a.specifics?.public_identifier), self: Number(a.is_self) === 1 || a.is_self === true,
  };
}

/** A message in a chat. Events (reactions, read receipts) and deleted messages are dropped. */
export type ChatMessage = { id: string; from: string; out: boolean; text: string; at: number };

export function chatMessageOf(raw: unknown): ChatMessage | null {
  const m = raw as { id?: unknown; sender_id?: unknown; is_sender?: unknown; text?: unknown; timestamp?: unknown; is_event?: unknown; deleted?: unknown };
  const id = str(m?.id);
  const from = str(m?.sender_id);
  const at = timeOf(m?.timestamp);
  if (!id || !from || !at || Number(m.is_event) === 1 || m.is_event === true || Number(m.deleted) === 1 || m.deleted === true) return null;
  return { id, from, out: Number(m.is_sender) === 1 || m.is_sender === true, text: typeof m.text === "string" ? m.text : "", at };
}

export type UnipileClient = ReturnType<typeof createUnipileClient>;

export function createUnipileClient(config: UnipileConfig) {
  if (config.requestTimeoutMs !== undefined && (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 || config.requestTimeoutMs > 30_000)) {
    throw new UnipileError(400, "canon/invalid_timeout");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const host = config.dsn.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const base = `https://${host}/api/v1`;

  /** JSON bodies by default; chats and messages take multipart form data (FormData sets its own content type). */
  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, extraHeaders: Record<string, string> = {}, timeoutMs = config.requestTimeoutMs): Promise<T> {
    let response: Response;
    const form = body instanceof FormData;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs), redirect: "error" as const }),
        headers: { "X-API-KEY": config.apiKey, Accept: "application/json", ...(body === undefined || form ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new UnipileError(503, "canon/unreachable");
    }
    if (!response.ok) throw new UnipileError(response.status, await errorType(response));
    return (response.status === 204 ? {} : await response.json()) as T;
  }

  return {
    /**
     * A link to Unipile's hosted login. `name` comes back on the notify
     * callback; Canon puts a signed state token there.
     */
    async hostedLink(opts: {
      name: string;
      notifyUrl: string;
      successUrl: string;
      failureUrl: string;
      expiresAt: Date;
      reconnectAccountId?: string;
      /** Which login the page offers: LinkedIn unless told otherwise. */
      provider?: "LINKEDIN" | "GOOGLE" | "OUTLOOK";
    }): Promise<string> {
      const out = await call<{ url?: unknown }>("POST", "/hosted/accounts/link", {
        type: opts.reconnectAccountId ? "reconnect" : "create",
        ...(opts.reconnectAccountId ? { reconnect_account: opts.reconnectAccountId } : { providers: [opts.provider ?? "LINKEDIN"] }),
        api_url: `https://${host}`,
        expiresOn: opts.expiresAt.toISOString(),
        notify_url: opts.notifyUrl,
        success_redirect_url: opts.successUrl,
        failure_redirect_url: opts.failureUrl,
        name: opts.name,
      });
      const url = str(out.url);
      if (!url || !url.startsWith("https://")) throw new UnipileError(502, "canon/no_hosted_url");
      return url;
    },

    async getMailAccount(accountId: string): Promise<UnipileMailAccount | null> {
      try {
        return mailAccountOf(await call("GET", `/accounts/${encodeURIComponent(accountId)}`));
      } catch (cause) {
        if (cause instanceof UnipileError && cause.status === 404) return null;
        throw cause;
      }
    },

    async sendEmail(accountId: string, email: { to: { address: string; name?: string }; subject: string; html: string; idempotencyKey: string }): Promise<{ providerId: string | null }> {
      const form = new FormData();
      form.append("account_id", accountId);
      form.append("to", JSON.stringify([{ identifier: email.to.address, ...(email.to.name ? { display_name: email.to.name } : {}) }]));
      form.append("subject", email.subject);
      form.append("body", email.html);
      const out = await call<{ provider_id?: unknown; tracking_id?: unknown }>("POST", "/emails", form, { "Idempotency-Key": email.idempotencyKey });
      return { providerId: str(out.provider_id) ?? str(out.tracking_id) };
    },

    async sendMailboxEmail(accountId: string, email: UnipileMailboxEmail): Promise<{ providerId: string | null }> {
      const form = new FormData();
      form.append("account_id", accountId);
      form.append("to", JSON.stringify([{ identifier: email.to }]));
      form.append("subject", email.subject);
      form.append("body", email.html);
      if (email.headers) form.append("custom_headers", JSON.stringify([
        { name: "List-Unsubscribe", value: email.headers.listUnsubscribe },
        { name: "List-Unsubscribe-Post", value: email.headers.listUnsubscribePost },
      ]));
      form.append("tracking_options", JSON.stringify({ opens: false, links: false }));
      let out: unknown;
      try { out = await call<unknown>("POST", "/emails", form, { "Idempotency-Key": email.idempotencyKey }, config.requestTimeoutMs ?? 20_000); }
      catch (cause) {
        const refused = cause instanceof UnipileError && (MAIL_DEFINITIVE_HTTP.has(cause.status) || cause.status === 422 && MAIL_DEFINITIVE_422.has(cause.type ?? ""));
        throw new UnipileError(cause instanceof UnipileError ? cause.status : 502, refused ? "canon/mail_refused" : "canon/mail_unconfirmed");
      }
      if (!out || typeof out !== "object" || Array.isArray(out) || !("object" in out) || out.object !== "EmailSent" || !("provider_id" in out)) return { providerId: null };
      const id = out.provider_id;
      return { providerId: typeof id === "string" && id.length > 0 && id.length <= 1000 && id.trim() === id && !/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(id) ? id : null };
    },

    /** Save an email as a draft in the account's mailbox (Gmail drafts): nothing is sent. */
    async createDraft(accountId: string, email: { to: { address: string; name?: string }; subject: string; html: string }): Promise<{ draftId: string | null }> {
      const form = new FormData();
      form.append("account_id", accountId);
      form.append("to", JSON.stringify([{ identifier: email.to.address, ...(email.to.name ? { display_name: email.to.name } : {}) }]));
      form.append("subject", email.subject);
      form.append("body", email.html);
      const out = await call<{ draft_id?: unknown }>("POST", "/drafts", form);
      return { draftId: str(out.draft_id) };
    },

    async getAccount(accountId: string): Promise<UnipileAccount | null> {
      try {
        return accountOf(await call("GET", `/accounts/${encodeURIComponent(accountId)}`));
      } catch (cause) {
        if (cause instanceof UnipileError && cause.status === 404) return null;
        throw cause;
      }
    },

    /** Removes the account from Unipile, which stops its billing and its session. */
    async deleteAccount(accountId: string): Promise<void> {
      try {
        await call("DELETE", `/accounts/${encodeURIComponent(accountId)}`);
      } catch (cause) {
        if (!(cause instanceof UnipileError && cause.status === 404)) throw cause;
      }
    },

    async listWebhooks(): Promise<{ id: string; url: string; source: string; name: string; events: string[] }[]> {
      const out = await call<{ items?: { id?: unknown; request_url?: unknown; source?: unknown; name?: unknown; events?: unknown }[] }>("GET", "/webhooks");
      return (out.items ?? []).flatMap((w) => (str(w.id) && str(w.request_url)
        ? [{ id: w.id as string, url: w.request_url as string, source: String(w.source ?? ""), name: String(w.name ?? ""), events: Array.isArray(w.events) ? w.events.map(String) : [] }]
        : []));
    },

    async deleteWebhook(webhookId: string): Promise<void> {
      await call("DELETE", `/webhooks/${encodeURIComponent(webhookId)}`);
    },

    async createWebhook(opts: { source: "account_status" | "messaging" | "users" | "email"; url: string; name: string; events?: string[] }): Promise<void> {
      await call("POST", "/webhooks", { source: opts.source, request_url: opts.url, name: opts.name, format: "json", ...(opts.events ? { events: opts.events } : {}) });
    },

    async selfProfile(accountId: string): Promise<Record<string, unknown>> {
      return call("GET", `/users/me?account_id=${encodeURIComponent(accountId)}`);
    },

    /** A profile by vanity slug or provider id, seen from the sender's account. */
    async getProfile(accountId: string, identifier: string): Promise<Profile | null> {
      try {
        return profileOf(await call("GET", `/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`));
      } catch (cause) {
        if (cause instanceof UnipileError && cause.status === 404) return null;
        throw cause;
      }
    },

    /** The person's latest posts (newest first), seen from the sender's account. A 404 reads as none. */
    async recentPosts(accountId: string, providerId: string, limit = 5): Promise<unknown[]> {
      return listOrEmpty(() => call<{ items?: unknown[] }>("GET", `/users/${encodeURIComponent(providerId)}/posts?account_id=${encodeURIComponent(accountId)}&limit=${limit}`));
    },

    /** The person's latest comments on posts. A 404 reads as none. */
    async recentComments(accountId: string, providerId: string, limit = 5): Promise<unknown[]> {
      return listOrEmpty(() => call<{ items?: unknown[] }>("GET", `/users/${encodeURIComponent(providerId)}/comments?account_id=${encodeURIComponent(accountId)}&limit=${limit}`));
    },

    async invite(accountId: string, providerId: string, message?: string): Promise<{ invitationId: string | null }> {
      const out = await call<{ invitation_id?: unknown }>("POST", "/users/invite", {
        account_id: accountId, provider_id: providerId, ...(message ? { message } : {}),
      });
      return { invitationId: str(out.invitation_id) };
    },

    /** Pending invites the sender sent: provider id of the invitee to invitation id. Reads up to `pages` pages. */
    async sentInvites(accountId: string, pages = 4): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      let cursor: string | null = null;
      for (let i = 0; i < pages; i++) {
        const page: { items?: { id?: unknown; invited_user_id?: unknown; invited_user_public_id?: unknown }[]; cursor?: unknown } = await call(
          "GET", `/users/invite/sent?account_id=${encodeURIComponent(accountId)}&limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        for (const item of page.items ?? []) {
          const id = str(item.id);
          if (!id) continue;
          const who = str(item.invited_user_id);
          const slug = str(item.invited_user_public_id);
          if (who) out.set(who, id);
          if (slug) out.set(slug.toLowerCase(), id);
        }
        cursor = str(page.cursor);
        if (!cursor) break;
      }
      return out;
    },

    async cancelInvite(accountId: string, invitationId: string): Promise<void> {
      try {
        await call("DELETE", `/users/invite/sent/${encodeURIComponent(invitationId)}?account_id=${encodeURIComponent(accountId)}`);
      } catch (cause) {
        if (!(cause instanceof UnipileError && cause.status === 404)) throw cause;
      }
    },

    /** The sender's connections, one page. Unipile doesn't document the order, so callers read a few pages. */
    async relations(accountId: string, cursor?: string): Promise<{ items: Relation[]; cursor: string | null }> {
      const out = await call<{ items?: unknown[]; cursor?: unknown }>("GET", `/users/relations?account_id=${encodeURIComponent(accountId)}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      return { items: (out.items ?? []).flatMap((r) => { const x = relationOf(r); return x ? [x] : []; }), cursor: str(out.cursor) };
    },

    /** The ids of the sender's chats with one person, most likely just one. */
    async chatsWith(accountId: string, providerId: string): Promise<string[]> {
      const out = await call<{ items?: { id?: unknown }[] }>("GET", `/chat_attendees/${encodeURIComponent(providerId)}/chats?account_id=${encodeURIComponent(accountId)}&limit=5`);
      return (out.items ?? []).flatMap((c) => (str(c.id) ? [c.id as string] : []));
    },

    /** Whether the other person wrote anything in the chat after `sinceMs`. */
    async repliedSince(chatId: string, sinceMs: number): Promise<boolean> {
      const after = new Date(sinceMs).toISOString();
      const out = await call<{ items?: { is_sender?: unknown }[] }>("GET", `/chats/${encodeURIComponent(chatId)}/messages?limit=50&after=${encodeURIComponent(after)}`);
      return (out.items ?? []).some((m) => Number(m.is_sender) === 0);
    },

    /** One page of the account's chats with activity after `afterMs`, newest first. */
    async listChats(accountId: string, opts: { afterMs: number; cursor?: string; limit: number }): Promise<{ items: ChatSummary[]; cursor: string | null }> {
      const q = `account_id=${encodeURIComponent(accountId)}&limit=${opts.limit}&after=${encodeURIComponent(new Date(opts.afterMs).toISOString())}${opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ""}`;
      const out = await call<{ items?: unknown[]; cursor?: unknown }>("GET", `/chats?${q}`);
      return { items: (out.items ?? []).flatMap((c) => chatSummaryOf(c) ?? []), cursor: str(out.cursor) };
    },

    async chatAttendees(chatId: string): Promise<ChatAttendee[]> {
      const out = await call<{ items?: unknown[] }>("GET", `/chats/${encodeURIComponent(chatId)}/attendees`);
      return (out.items ?? []).flatMap((a) => chatAttendeeOf(a) ?? []);
    },

    /**
     * A chat's messages after `afterMs`, up to `pages` pages of 100 from `from` (the start, or where an earlier
     * read stopped). `cursor` is where the next read starts, null once the chat is read to its end.
     */
    async chatMessages(chatId: string, afterMs: number, pages: number, from: string | null = null): Promise<{ messages: ChatMessage[]; cursor: string | null }> {
      const out: ChatMessage[] = [];
      let cursor: string | null = from;
      for (let i = 0; i < pages; i++) {
        const page: { items?: unknown[]; cursor?: unknown } = await call(
          "GET", `/chats/${encodeURIComponent(chatId)}/messages?limit=100&after=${encodeURIComponent(new Date(afterMs).toISOString())}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        for (const m of page.items ?? []) {
          const x = chatMessageOf(m);
          if (x) out.push(x);
        }
        cursor = str(page.cursor);
        if (!cursor) break;
      }
      return { messages: out, cursor };
    },

    /** Start a chat with one message. `messageId` is LinkedIn's id of that message, when Unipile sends it. */
    async startChat(accountId: string, providerId: string, text: string): Promise<{ chatId: string | null; messageId: string | null }> {
      const form = new FormData();
      form.append("account_id", accountId);
      form.append("attendees_ids", providerId);
      form.append("text", text);
      const out = await call<{ chat_id?: unknown; message_id?: unknown }>("POST", "/chats", form);
      return { chatId: str(out.chat_id), messageId: str(out.message_id) };
    },

    /** Send a message in a chat. `messageId` is its id, which the account's own webhook echo carries too. */
    async sendMessage(accountId: string, chatId: string, text: string): Promise<{ messageId: string | null }> {
      const form = new FormData();
      form.append("account_id", accountId);
      form.append("text", text);
      const out = await call<{ message_id?: unknown }>("POST", `/chats/${encodeURIComponent(chatId)}/messages`, form);
      return { messageId: str(out?.message_id) };
    },

    /** One page of an inbox's email after `afterMs`, in full with headers, for conversation intake (CI2). Raw items: lib/conversations/email.ts reads them. */
    async listEmails(accountId: string, opts: { afterMs: number; cursor?: string; limit: number }): Promise<{ items: unknown[]; cursor: string | null }> {
      const q = `account_id=${encodeURIComponent(accountId)}&limit=${opts.limit}&include_headers=true&after=${encodeURIComponent(new Date(opts.afterMs).toISOString())}${opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ""}`;
      const out = await call<{ items?: unknown[]; cursor?: unknown }>("GET", `/emails?${q}`);
      return { items: out.items ?? [], cursor: str(out.cursor) };
    },

    /** One email in full with headers, or null when it is gone. */
    async getEmail(accountId: string, emailId: string): Promise<unknown | null> {
      try {
        return await call<unknown>("GET", `/emails/${encodeURIComponent(emailId)}?account_id=${encodeURIComponent(accountId)}&include_headers=true`);
      } catch (cause) {
        if (cause instanceof UnipileError && cause.status === 404) return null;
        throw cause;
      }
    },
  };
}

/** The account-status webhook's message, normalized: which account, and what Unipile says about it. */
export function accountStatusEvent(payload: unknown): { accountId: string; message: string } | null {
  const s = (payload as { AccountStatus?: { account_id?: unknown; message?: unknown } })?.AccountStatus;
  const accountId = str(s?.account_id);
  const message = str(s?.message);
  return accountId && message ? { accountId, message } : null;
}

/** The hosted-auth notify callback: which account was created or reconnected, and the state we sent. */
export function notifyEvent(payload: unknown): { accountId: string; name: string; status: string } | null {
  const p = payload as { status?: unknown; account_id?: unknown; name?: unknown };
  const accountId = str(p?.account_id);
  const name = str(p?.name);
  const status = str(p?.status);
  return accountId && name && status ? { accountId, name, status } : null;
}

export type CanonAccountStatus = "ok" | "credentials" | "paused" | "disconnected";

/**
 * Unipile's status, as Canon's. A transient state (connecting, syncing) keeps
 * the current one; anything needing the user's login is "credentials"; an
 * error or a stop pauses sending.
 */
export function statusFromUnipile(message: string, current: CanonAccountStatus): CanonAccountStatus {
  switch (message.toUpperCase()) {
    case "OK":
    case "CREATION_SUCCESS":
    case "RECONNECTED":
    case "SYNC_SUCCESS":
      return current === "disconnected" ? current : "ok";
    case "CREDENTIALS":
      return current === "disconnected" ? current : "credentials";
    case "ERROR":
    case "STOPPED":
      return current === "disconnected" ? current : "paused";
    case "DELETION":
      return "disconnected";
    default:
      return current;
  }
}
