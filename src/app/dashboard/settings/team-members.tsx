"use client";

import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useClerk, useOrganization } from "@clerk/nextjs";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select";
import { DateInput } from "@/components/ui/date-input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { awaitsLogin } from "../../../../convex/lib/clerkRoles";
import { parseCsv } from "../../../../convex/lib/objects/csvImport";
import { LOCAL_AUTH } from "@/lib/authMode";

const btn = "inline-flex h-8 items-center gap-1.5 border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = cn(btn, "border-primary bg-primary text-primary-foreground hover:bg-primary/85");
const input = "h-8 w-full border border-input bg-background px-2 text-sm outline-none focus:border-primary";

/** Clerk runs sign-in and invites; a local stack bypasses it (convex-provider.tsx). */
export const CLERK_ON = !LOCAL_AUTH && !((process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) || process.env.NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS === "true");

type Invite = (member: { _id: Id<"users">; email: string; role: string }) => Promise<void>;

/** Send a member Clerk's invite email to the active workspace (users.invite); accepting it signs them in as this member. */
function useClerkInvite(): Invite | null {
  const { organization } = useOrganization();
  const invite = useAction(api.users.invite);
  if (!organization) return null;
  return async (member) => { await invite({ userId: member._id }); };
}
/** Null on a local stack, which has no Clerk to send invites. The choice is fixed at load, so hook order never changes. */
function useLocalInvite(): Invite {
  const invite = useMutation(api.localAuth.invite);
  return async (member) => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    await invite({ userId: member._id, tokenHash });
    window.dispatchEvent(new CustomEvent("canon-local-invite", { detail: `${window.location.origin}/sign-up?invite=${token}` }));
  };
}
export const useInvite: () => Invite | null = LOCAL_AUTH ? useLocalInvite : CLERK_ON ? useClerkInvite : () => null;

/** Settings > Team, Invite on a row with no login: the same invite Add member sends. */
export function InviteRowButton({ member }: { member: { _id: Id<"users">; email: string; role: string; invitedAt?: number } }) {
  const invite = useInvite();
  const [busy, setBusy] = useState(false);
  if (!invite) return null;
  return (
    <button type="button" className="text-xs text-primary hover:underline disabled:opacity-50" disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await invite(member); void toast.success(LOCAL_AUTH ? "Invitation link ready" : `Invite sent to ${member.email}`); }
        catch (cause) { void toast.error(getErrorMessage(cause)); }
        finally { setBusy(false); }
      }}>
      {busy ? "Sending…" : member.invitedAt ? "Resend invite" : "Invite"}
    </button>
  );
}

function ClerkPendingInvites() {
  const clerk = useClerk();
  return <button type="button" className={btn} onClick={() => clerk.openOrganizationProfile()}>Pending invites</button>;
}
/** Clerk's members screen, where a sent invite is revoked. None on a local stack. */
export const PendingInvitesButton: () => React.ReactNode = CLERK_ON ? ClerkPendingInvites : () => null;

/** How a member gets in: added in Canon with no login, a CRM owner from a sync, or a person who signs in. */
export function loginOf(member: { clerkUserId: string; lastLoginAt?: number; invitedAt?: number }): { label: string; hint: string } {
  if (awaitsLogin(member.clerkUserId) && member.invitedAt) return { label: "Invited", hint: `Invite sent ${new Date(member.invitedAt).toLocaleDateString()}; they sign in as this member when they accept.` };
  if (member.clerkUserId.startsWith("member:")) return { label: "No login", hint: "Added in Canon. An invite to this email lets them sign in as this member." };
  if (/^(hubspot|salesforce):/.test(member.clerkUserId)) return { label: "CRM owner", hint: "Synced from the CRM as a deal owner. An invite lets them sign in." };
  return { label: "Signs in", hint: member.lastLoginAt ? `Last signed in ${new Date(member.lastLoginAt).toLocaleDateString()}` : "Has a login" };
}

/** Settings > Team, Add member: one record (users.createMember) that owns deals and sits on teams, with an optional invite to sign in as it. */
export function NewMemberDialog({ roles, managers, onClose }: {
  roles: ReadonlyArray<{ value: string; label: string }>;
  managers: ReadonlyArray<{ _id: Id<"users">; name: string }>;
  onClose: () => void;
}) {
  const create = useMutation(api.users.createMember);
  const invite = useInvite();
  const [form, setForm] = useState({ name: "", email: "", role: "rep", title: "", managerId: "", startDate: "" });
  const [sendInvite, setSendInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  // Adding an admin asks first, as changing a row's role to Admin does; Cancel goes back to the form.
  const [askingAdmin, setAskingAdmin] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const ready = form.name.trim() !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  async function save() {
    setBusy(true);
    try {
      const id = await create({
        name: form.name, email: form.email, role: form.role, ...(form.title.trim() ? { title: form.title } : {}),
        ...(form.managerId ? { managerId: form.managerId as Id<"users"> } : {}), ...(form.startDate ? { startDate: form.startDate } : {}),
      });
      if (invite && sendInvite) {
        // The member exists either way; a failed invite says so and can be resent from their row.
        try {
          await invite({ _id: id, email: form.email.trim().toLowerCase(), role: form.role });
          void toast.success(`${form.name.trim()} added and invited`);
        } catch (cause) {
          void toast.error(`${form.name.trim()} added, but the invite failed: ${getErrorMessage(cause)}`);
        }
      } else {
        void toast.success(`${form.name.trim()} added`);
      }
      onClose();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add team member</DialogTitle>
          <DialogDescription>{LOCAL_AUTH ? "They can own deals and sit on teams. Create an invitation link so they can choose a password and sign in." : "They can own deals and sit on teams. With an invite, they get an email and sign in as this member; without one, they have no login until you invite them from their row."}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (!ready) return; if (form.role === "admin") setAskingAdmin(true); else void save(); }}>
          <label className="grid gap-1 font-medium">Name<input className={input} value={form.name} onChange={(e) => set("name")(e.target.value)} autoFocus /></label>
          <label className="grid gap-1 font-medium">Email<input className={input} type="email" value={form.email} onChange={(e) => set("email")(e.target.value)} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 font-medium">Role<SelectField size="default" aria-label="Role" value={form.role} onValueChange={set("role")} className="w-full" options={roles} /></label>
            <label className="grid gap-1 font-medium">Title<input className={input} value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="Account Executive" /></label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 font-medium">Manager
              <SelectField size="default" aria-label="Manager" value={form.managerId} onValueChange={set("managerId")} className="w-full"
                options={[{ value: "", label: "No manager" }, ...managers.map((m) => ({ value: m._id, label: m.name }))]} />
            </label>
            <div className="grid gap-1 font-medium">Start date<DateInput value={form.startDate} onChange={set("startDate")} /></div>
          </div>
          <label className="flex items-center gap-2" title={invite ? undefined : "Invites go through Clerk, which a local stack bypasses"}>
            <input type="checkbox" checked={!!invite && sendInvite} disabled={!invite} onChange={(e) => setSendInvite(e.target.checked)} />
            {LOCAL_AUTH ? "Create an invitation link so they can sign in" : "Send an invite email so they can sign in"}
          </label>
          <DialogFooter>
            <button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={primary} disabled={busy || !ready}>{busy ? "Adding…" : invite && sendInvite ? "Add and invite" : "Add member"}</button>
          </DialogFooter>
        </form>
        {askingAdmin && (
          <ConfirmDialog title="Grant admin access?"
            description={`${form.name.trim() || "This member"} will be able to manage billing, integrations, team access and every workspace setting.`}
            confirmLabel="Grant admin access" onConfirm={save} onClose={() => setAskingAdmin(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Line = FunctionReturnType<typeof api.users.importReportingLines>[number];
const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

/** The member and manager email columns of a reporting-lines file: `email` and `managerEmail` (or close: "Manager email", "Reports to"). */
export function readReportingLines(text: string): { ok: true; rows: Array<{ email: string; managerEmail: string }> } | { ok: false; message: string } {
  const [header, ...body] = parseCsv(text);
  if (!header || !body.length) return { ok: false, message: "The file needs a header row and at least one row" };
  const cols = header.map(norm);
  const manager = cols.findIndex((c) => ["manageremail", "manager", "reportsto", "reportstoemail"].includes(c));
  const email = cols.findIndex((c, i) => i !== manager && ["email", "memberemail", "useremail", "repemail"].includes(c));
  if (email < 0 || manager < 0) return { ok: false, message: "The file needs an email column and a managerEmail column" };
  return { ok: true, rows: body.filter((r) => r.some((c) => c.trim())).map((r) => ({ email: r[email] ?? "", managerEmail: r[manager] ?? "" })) };
}

const STATUS: Record<Line["status"], string> = { set: "Set", cleared: "Cleared", unchanged: "No change", refused: "Refused" };

/** Settings > Team, Import reporting lines: a CSV of email and managerEmail, checked row by row before it is applied. */
export function ReportingLinesImport({ onClose }: { onClose: () => void }) {
  const run = useMutation(api.users.importReportingLines);
  const [rows, setRows] = useState<Array<{ email: string; managerEmail: string }> | null>(null);
  const [preview, setPreview] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState(false);
  const changes = (preview ?? []).filter((l) => l.status === "set" || l.status === "cleared").length;

  async function choose(file: File) {
    const read = readReportingLines(await file.text());
    if (!read.ok) { void toast.error(read.message); return; }
    setBusy(true);
    try {
      setRows(read.rows);
      setPreview(await run({ rows: read.rows, apply: false }));
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!rows) return;
    setBusy(true);
    try {
      const done = await run({ rows, apply: true });
      const n = done.filter((l) => l.status === "set" || l.status === "cleared").length;
      void toast.success(`${n} reporting ${n === 1 ? "line" : "lines"} set`);
      onClose();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const sample = `data:text/csv;charset=utf-8,${encodeURIComponent("email,managerEmail\nrep@yourcompany.com,manager@yourcompany.com\n")}`;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import reporting lines</DialogTitle>
          <DialogDescription>A CSV with each member&apos;s email and their manager&apos;s email. An empty manager clears it. Each row is checked as an edit here is, so the file can&apos;t make a loop.</DialogDescription>
        </DialogHeader>
        <a className="text-xs underline" href={sample} download="reporting-lines-sample.csv">Download a sample CSV</a>
        <input type="file" accept=".csv,text/csv" aria-label="Reporting lines CSV" disabled={busy} className="text-xs"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }} />
        {preview && (
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">Row</th><th className="py-1">Member</th><th className="py-1">Manager</th><th className="py-1">Result</th></tr></thead>
            <tbody>
              {preview.map((l) => (
                <tr key={l.row} className="border-t border-border">
                  <td className="py-1 pr-2 font-mono">{l.row}</td>
                  <td className="py-1 pr-2">{l.email}</td>
                  <td className="py-1 pr-2">{l.manager ?? (l.status === "cleared" ? "None" : "")}</td>
                  <td className={cn("py-1", l.status === "refused" && "text-destructive")}>{STATUS[l.status]}{l.message ? `: ${l.message}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <DialogFooter>
          <button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primary} disabled={busy || !changes} onClick={() => void apply()}>
            {preview ? `Set ${changes} ${changes === 1 ? "line" : "lines"}` : "Set lines"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
