"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cn, getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  EmptyState,
  LoadingRows,
  DataTable,
  SummaryCard,
} from "@/components/dashboard";
import { Copy, Eye, EyeOff, Search, SearchX, ShieldAlert, Upload, UserCheck, UserPlus, Users } from "lucide-react";
import { SelectField } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateInput } from "@/components/ui/date-input";
import { baseRole } from "../../../../convex/lib/roles";
import { awaitsLogin } from "../../../../convex/lib/clerkRoles";
import { useUrlState } from "@/lib/url-state";
import { useSettingsAccess } from "./settings-ui";
import { InviteRowButton, PendingInvitesButton, NewMemberDialog, ReportingLinesImport, loginOf } from "./team-members";
import { clearableKeys, linkedColumnFilters, managerMatches, type LinkColumn } from "./team-links";

const btn = "inline-flex h-8 items-center gap-1.5 border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50";

const BUILT_IN = [
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "rep", label: "Rep" },
  { value: "other", label: "Other" },
];

/** What the list can be grouped by. Teams stand in for business units: a workspace's own groups of members. */
const GROUPS = [
  { value: "", label: "No grouping" }, { value: "role", label: "Group by role" }, { value: "manager", label: "Group by manager" },
  { value: "title", label: "Group by title" }, { value: "team", label: "Group by team" }, { value: "status", label: "Group by status" }, { value: "login", label: "Group by login" },
];

export function TeamTab() {
  const userWorkspace = useQuery(api.users.context);
  const members = userWorkspace?.users;
  const updateUser = useMutation(api.users.update);
  const startPreview = useMutation(api.permissions.startPreview);
  const me = useQuery(api.users.me);
  const { isAdmin } = useSettingsAccess();
  // Teams, and so the Team column, filter and grouping, are an admin's (Settings > Permissions reads them).
  const permissions = useQuery(api.permissions.settings);
  // A link may name a title, a manager (name or id), a search, a role, a status, or a module column's value
  // (?title=Account Executive, ?manager=Jordan Patel, ?plan=AE Monthly): team-links.ts reads them.
  const [url, setUrl] = useUrlState({ title: "", team: "", group: "", hidden: "", manager: "", role: "", status: "" });
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // The search box starts from ?search= and follows a later link's; typing stays local (no URL write per key).
  const linkedSearch = searchParams.get("search") ?? "";
  const [search, setSearch] = useState(linkedSearch);
  useEffect(() => setSearch(linkedSearch), [linkedSearch]);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // A change to or from Admin waits for a yes: it gives or takes billing, integrations and every setting.
  const [adminChange, setAdminChange] = useState<{ id: Id<"users">; name: string; role: string; adding: boolean } | null>(null);

  // Columns the workspace's modules add here (a rep's commission plans), read as the viewer reads each module's docs.
  const contributed = useQuery(api.modules.contributions, { page: "team" });
  // `keys` (a value's doc key, when the server sends them) lets a link name a value by key: ?plan=<plan key>.
  const moduleColumns = useMemo(() => (contributed ?? []).flatMap((m) => (m.columns ?? []).map((c, i) => ({ ...c, keys: (c as { keys?: Record<string, string> }).keys, id: `${m.module}:${i}`, module: m.title, partial: m.partial }))), [contributed]);
  const [pickedFilters, setModuleFilters] = useState<Record<string, string>>({});
  // A column's filter is the one picked here, else the one the URL links to.
  const moduleFilters = useMemo(() => ({ ...linkedColumnFilters(searchParams, moduleColumns as LinkColumn[]), ...pickedFilters }), [searchParams, moduleColumns, pickedFilters]);
  // Members picked for a bulk edit, and the role or manager it sets.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [bulkRole, setBulkRole] = useState("");
  const [bulkManager, setBulkManager] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const roleOptions = useMemo(() => [...BUILT_IN, ...(userWorkspace?.roles ?? []).map((r) => ({ value: r.key, label: r.name }))], [userWorkspace?.roles]);
  const [savingId, setSavingId] = useState<string | null>(null);

  const teamsOf = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const t of permissions?.teams ?? []) for (const id of [...t.memberIds, ...(t.leadId ? [t.leadId] : [])]) out.set(id, [...new Set([...(out.get(id) ?? []), t.name])]);
    return out;
  }, [permissions?.teams]);
  const hiddenCount = (members ?? []).filter((m) => m.isHidden).length;
  const titles = useMemo(() => [...new Set((members ?? []).flatMap((m) => (m.title ? [m.title] : [])))].sort((a, b) => a.localeCompare(b)), [members]);

  const rows = useMemo(() => {
    if (!members) return [];
    const membersById = new Map(members.map((member) => [member._id, member]));
    return members
      .map((member) => ({
        ...member,
        managerName: member.managerId
          ? membersById.get(member.managerId)?.name ?? "Unknown"
          : null,
        teams: teamsOf.get(member._id) ?? [],
        login: loginOf(member),
      }))
      .filter((member) => url.hidden === "1" || !member.isHidden)
      .filter((member) => !url.title || (member.title ?? "") === url.title)
      .filter((member) => !url.team || member.teams.includes(url.team))
      .filter((member) => !url.role || member.role === url.role)
      .filter((member) => managerMatches(url.manager, member))
      .filter((member) => !url.status || member.isActive === (url.status === "active"))
      .filter((member) => moduleColumns.every((c) => {
        const want = moduleFilters[c.id];
        if (!want) return true;
        const has = c.values[member._id] ?? [];
        return want === "#none" ? has.length === 0 : has.includes(want);
      }))
      .filter((member) => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        const text = [member.name, member.email, member.title, member.managerName, ...member.teams, ...moduleColumns.flatMap((c) => c.values[member._id] ?? [])];
        return text.some((t) => (t ?? "").toLowerCase().includes(q));
      })
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [members, moduleColumns, moduleFilters, teamsOf, search, url.hidden, url.title, url.team, url.role, url.manager, url.status]);
  /** Clear filters: the search, every filter, and the query keys a link set (the tab, grouping and Hidden stay). */
  function clearFilters() {
    setSearch("");
    setModuleFilters({});
    const next = new URLSearchParams(searchParams.toString());
    for (const k of clearableKeys(searchParams)) next.delete(k);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }
  const roleLabel = (key: string) => roleOptions.find((o) => o.value === key)?.label ?? key;
  const groupOf = useMemo(() => {
    const by: Record<string, (m: (typeof rows)[number]) => string> = {
      role: (m) => roleLabel(m.role), manager: (m) => m.managerName ?? "No manager", title: (m) => m.title || "No title",
      team: (m) => m.teams.join(", ") || "No team", status: (m) => (m.isActive ? "Active" : "Inactive"), login: (m) => m.login.label,
    };
    return by[url.group];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.group, roleOptions]);
  const noAdmin = members !== undefined && members.length > 0 && !members.some((m) => m.isActive && !m.isHidden && m.role === "admin");

  const managerOptions = useMemo(() => {
    // A workspace role counts as its base: one that counts as a manager can manage reps.
    const bases = Object.fromEntries((userWorkspace?.roles ?? []).map((r) => [r.key, r.base]));
    return (members ?? []).filter(
      (member) => member.isActive && !member.isHidden && ["admin", "manager"].includes(baseRole(member.role, bases)),
    );
  }, [members, userWorkspace?.roles]);

  // ?manager= may name the manager by name: the picker shows the member it names, or the name as it came.
  const managerPick = useMemo(() => {
    if (!url.manager || url.manager === "none") return url.manager;
    const named = (members ?? []).find((m) => m._id === url.manager || m.name.toLowerCase() === url.manager.trim().toLowerCase());
    return named?._id ?? url.manager;
  }, [url.manager, members]);
  const managerPickOptions = useMemo(() => {
    const opts = managerOptions.map((m) => ({ value: m._id as string, label: m.name }));
    if (managerPick && managerPick !== "none" && !opts.some((o) => o.value === managerPick)) {
      opts.push({ value: managerPick, label: (members ?? []).find((m) => m._id === managerPick)?.name ?? managerPick });
    }
    return opts;
  }, [managerOptions, managerPick, members]);

  const summary = useMemo(() => {
    const activeMembers = (members ?? []).filter(
      (member) => member.isActive && !member.isHidden,
    );
    return {
      activeTeam: activeMembers.length,
      reps: activeMembers.filter((member) => member.role === "rep").length,
      managers: activeMembers.filter(
        (member) => member.role === "manager" || member.role === "admin",
      ).length,
    };
  }, [members]);

  async function updateMember(
    userId: Id<"users">,
    updates: {
      title?: string;
      role?: string;
      managerId?: Id<"users"> | null;
      isActive?: boolean;
      isHidden?: boolean;
      startDate?: string | null;
      endDate?: string | null;
    },
    done?: string,
  ) {
    setSavingId(userId);
    try {
      await updateUser({ userId, ...updates });
      if (done) void toast.success(done);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setSavingId(null);
    }
  }

  /** A role change: to or from Admin asks first. */
  function changeRole(member: { _id: Id<"users">; name: string; role: string }, role: string) {
    if (role === member.role) return;
    if (role === "admin" || member.role === "admin") { setAdminChange({ id: member._id, name: member.name, role, adding: role === "admin" }); return; }
    void updateMember(member._id, { role }, `${member.name} is now ${roleLabel(role)}`);
  }

  /** The manager picker leaves out the member and everyone who reports to them, directly or not: they can't manage them. */
  const reportsOf = (id: string) => {
    const out = new Set<string>([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const m of members ?? []) if (m.managerId && out.has(m.managerId) && !out.has(m._id)) { out.add(m._id); grew = true; }
    }
    return out;
  };

  async function viewAs(member: { _id: Id<"users">; name: string }) {
    try {
      await startPreview({ asUserId: member._id });
      void toast.success(`Viewing as ${member.name}. Changes are off until you exit.`);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    }
  }

  /** Set the picked members' role or manager, one member at a time with every check; refusals are named. */
  async function applyBulk() {
    const ids = rows.filter((m) => picked.has(m._id)).map((m) => m._id);
    const updates = { ...(bulkRole ? { role: bulkRole } : {}), ...(bulkManager ? { managerId: bulkManager === "none" ? null : (bulkManager as Id<"users">) } : {}) };
    if (!ids.length || !Object.keys(updates).length) return;
    setBulkBusy(true);
    let done = 0;
    const refused: string[] = [];
    for (const id of ids) {
      try { await updateUser({ userId: id, ...updates, ...(updates.managerId === id ? { managerId: undefined } : {}) }); done++; }
      catch (cause) { refused.push(`${members?.find((m) => m._id === id)?.name ?? "A member"}: ${getErrorMessage(cause)}`); }
    }
    setBulkBusy(false);
    if (refused.length) void toast.error(`${done} updated, ${refused.length} refused. ${refused.slice(0, 3).join("; ")}`);
    else { void toast.success(`${done} ${done === 1 ? "member" : "members"} updated`); setPicked(new Set()); setBulkRole(""); setBulkManager(""); }
  }
  const toggle = (id: string) => setPicked((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  if (members === undefined) {
    return <LoadingRows count={3} />;
  }

  if (members.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No team members yet"
        description="Members join when they accept an organization invite, or import as CRM owners on sync."
        action={{ label: "Connect CRM", href: "/dashboard/integrations" }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SummaryCard label="Active Members" value={summary.activeTeam} icon={Users} />
        <SummaryCard label="Reps" value={summary.reps} icon={UserCheck} />
        <SummaryCard label="Managers" value={summary.managers} icon={Users} />
      </div>

      {noAdmin && (
        <div role="alert" className="flex items-start gap-2 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>No active member is an admin. Make someone Admin so billing, integrations and who sees what can be changed.</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">Add a member with or without an invite; CRM owners also arrive on sync.</span>
        {isAdmin && <button type="button" className={btn} onClick={() => setImporting(true)}><Upload className="size-3.5" />Import reporting lines</button>}
        {isAdmin && <button type="button" className={btn} onClick={() => setCreating(true)}><UserPlus className="size-3.5" />Add member</button>}
        {isAdmin && <PendingInvitesButton />}
      </div>
      {creating && <NewMemberDialog roles={roleOptions} managers={managerOptions} onClose={() => setCreating(false)} />}
      {importing && <ReportingLinesImport onClose={() => setImporting(false)} />}
      {adminChange && (
        <ConfirmDialog
          title={adminChange.adding ? "Grant admin access?" : "Remove admin access?"}
          description={adminChange.adding
            ? `${adminChange.name} will be able to manage billing, integrations, team access and every workspace setting.`
            : `${adminChange.name} will no longer manage billing, integrations, team access or workspace settings. They become ${roleLabel(adminChange.role)}.`}
          confirmLabel={adminChange.adding ? "Grant admin access" : "Remove admin access"}
          destructive={!adminChange.adding}
          onConfirm={() => updateMember(adminChange.id, { role: adminChange.role }, `${adminChange.name} is now ${roleLabel(adminChange.role)}`)}
          onClose={() => setAdminChange(null)} />
      )}

      {picked.size > 0 && (
        <div role="region" aria-label="Picked members" className="flex flex-wrap items-center gap-2 border-l-2 border-foreground bg-muted/40 px-3 py-2 text-xs">
          <span className="font-medium tabular-nums">{picked.size} picked</span>
          <SelectField aria-label="Set role" value={bulkRole} onValueChange={setBulkRole} className="w-36" options={[{ value: "", label: "Role: keep" }, ...roleOptions]} />
          <SelectField aria-label="Set manager" value={bulkManager} onValueChange={setBulkManager} className="w-44"
            options={[{ value: "", label: "Manager: keep" }, { value: "none", label: "No manager" }, ...managerOptions.map((m) => ({ value: m._id, label: m.name }))]} />
          <button type="button" className={btn} disabled={bulkBusy || (!bulkRole && !bulkManager)} onClick={() => setConfirmingBulk(true)}>{bulkBusy ? "Applying…" : "Apply"}</button>
          {confirmingBulk && (
            <ConfirmDialog
              title={`Apply to ${picked.size} picked ${picked.size === 1 ? "member" : "members"}?`}
              description={[bulkRole ? `Role: ${roleOptions.find((o) => o.value === bulkRole)?.label ?? bulkRole}` : "", bulkManager ? `Manager: ${bulkManager === "none" ? "none" : managerOptions.find((m) => m._id === bulkManager)?.name ?? "picked"}` : ""].filter(Boolean).join(". ") + ". Each member is checked as on their own."}
              confirmLabel="Apply"
              onConfirm={applyBulk}
              onClose={() => setConfirmingBulk(false)} />
          )}
          <button type="button" className="ml-auto text-muted-foreground underline" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      <DataTable
        enableSearch={false}
        emptyState={
          <div className="flex flex-col items-center gap-2 py-4">
            <SearchX className="size-6 text-muted-foreground opacity-40" />
            <span className="text-sm font-medium text-foreground">No members match these filters</span>
            <button type="button" className={btn} onClick={clearFilters}>Clear filters</button>
          </div>
        }
        initialSort={{ key: "name", direction: "asc" }}
        groupBy={groupOf}
        pageSize={50}
        filters={
          <>
            <label className="relative w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input aria-label="Search team" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search team, email, title, manager..."
                className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary" />
            </label>
            {titles.length > 0 && (
              <SelectField size="default" aria-label="Filter by title" value={url.title} onValueChange={(v) => setUrl({ title: v })}
                options={[{ value: "", label: "All titles" }, ...(url.title && !titles.includes(url.title) ? [url.title] : []).concat(titles).map((t) => ({ value: t, label: t }))]} />
            )}
            {(permissions?.teams.length ?? 0) > 0 && (
              <SelectField size="default" aria-label="Filter by team" value={url.team} onValueChange={(v) => setUrl({ team: v })}
                options={[{ value: "", label: "All teams" }, ...permissions!.teams.map((t) => ({ value: t.name, label: t.name }))]} />
            )}
            <SelectField size="default" aria-label="Group by" value={url.group} onValueChange={(v) => setUrl({ group: v })}
              options={GROUPS.filter((g) => g.value !== "team" || (permissions?.teams.length ?? 0) > 0)} />
            {hiddenCount > 0 && (
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" aria-label="Show hidden members" checked={url.hidden === "1"} onChange={(e) => setUrl({ hidden: e.target.checked ? "1" : "" })} />
                Hidden ({hiddenCount})
              </label>
            )}
            <SelectField
              size="default"
              aria-label="Filter by role"
              value={url.role}
              onValueChange={(v) => setUrl({ role: v })}
              options={[{ value: "", label: "All roles" }, ...roleOptions]}
            />
            <SelectField
              size="default"
              aria-label="Filter by manager"
              value={managerPick}
              onValueChange={(v) => setUrl({ manager: v })}
              options={[{ value: "", label: "All managers" }, { value: "none", label: "No manager" }, ...managerPickOptions]}
            />
            <SelectField
              size="default"
              aria-label="Filter by status"
              value={url.status}
              onValueChange={(v) => setUrl({ status: v })}
              options={[{ value: "", label: "Any status" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]}
            />
            {moduleColumns.filter((c) => c.filter).map((c) => (
              <SelectField key={c.id} size="default" aria-label={`Filter by ${c.label}`} value={moduleFilters[c.id] ?? ""}
                onValueChange={(v) => setModuleFilters((f) => ({ ...f, [c.id]: v }))}
                options={[{ value: "", label: `Any ${c.label.toLowerCase()}` }, { value: "#none", label: `No ${c.label.toLowerCase()}` },
                  ...[...new Set([...Object.values(c.values).flat(), ...(moduleFilters[c.id] && moduleFilters[c.id] !== "#none" ? [moduleFilters[c.id]] : [])])].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }))]} />
            ))}
            <button type="button" className={btn} disabled={rows.length === 0} onClick={() => setPicked(new Set(rows.map((m) => m._id)))}>Pick all {rows.length}</button>
          </>
        }
        columns={[
          {
            key: "pick",
            header: "",
            sortable: false,
            exportValue: null,
            render: (member) => <input type="checkbox" aria-label={`Pick ${member.name}`} checked={picked.has(member._id)} onChange={() => toggle(member._id)} />,
          },
          {
            key: "name",
            header: "Member",
            searchValue: (member) =>
              `${member.name} ${member.email} ${member.title ?? ""}`,
            sortValue: (member) => member.name,
            render: (member) => (
              <div>
                <div className="font-medium">{member.name}{member.isHidden && <span className="ml-1.5 border border-border px-1 text-[11px] font-normal text-muted-foreground">Hidden</span>}</div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {member.email}
                  <button type="button" aria-label={`Copy ${member.name}'s email`} title="Copy email" className="p-0.5 hover:text-foreground"
                    onClick={() => void navigator.clipboard.writeText(member.email).then(() => toast.success("Email copied"), () => toast.error("Couldn't copy the email"))}>
                    <Copy className="size-3" />
                  </button>
                </div>
              </div>
            ),
          },
          {
            key: "role",
            header: "Role",
            sortValue: (member) => member.role,
            render: (member) => (
              <SelectField
                aria-label={`Role of ${member.name}`}
                value={member.role}
                disabled={savingId === member._id}
                onValueChange={(v) => changeRole(member, v)}
                options={roleOptions}
              />
            ),
          },
          {
            key: "title",
            header: "Title",
            searchValue: (member) => member.title,
            render: (member) => (
              <input
                key={`${member._id}-${member.title ?? ""}`}
                defaultValue={member.title ?? ""}
                disabled={savingId === member._id}
                onBlur={(event) => {
                  const nextTitle = event.currentTarget.value.trim();
                  if (nextTitle !== (member.title ?? "")) {
                    updateMember(member._id, { title: nextTitle });
                  }
                }}
                placeholder="Set title"
                className="h-8 w-44 rounded-lg border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-primary disabled:opacity-60"
              />
            ),
          },
          {
            key: "manager",
            header: "Manager",
            searchValue: (member) => member.managerName,
            render: (member) => (
              <SelectField
                aria-label={`Manager of ${member.name}`}
                value={member.managerId ?? ""}
                disabled={savingId === member._id}
                onValueChange={(v) =>
                  updateMember(member._id, {
                    managerId: v ? (v as Id<"users">) : null,
                  })
                }
                className="w-44"
                options={(() => {
                  const own = reportsOf(member._id);
                  return [
                    { value: "", label: "No manager" },
                    ...managerOptions
                      .filter((manager) => !own.has(manager._id))
                      .map((manager) => ({ value: manager._id, label: manager.name })),
                  ];
                })()}
              />
            ),
          },
          {
            key: "startDate",
            header: "Start date",
            sortValue: (member) => member.startDate ?? null,
            exportValue: (member) => member.startDate ?? "",
            render: (member) => (
              <DateInput className="w-36" value={member.startDate ?? ""} onChange={(v) => { if (v !== (member.startDate ?? "")) void updateMember(member._id, { startDate: v || null }); }} />
            ),
          },
          {
            key: "endDate",
            header: "End date",
            sortValue: (member) => member.endDate ?? null,
            exportValue: (member) => member.endDate ?? "",
            render: (member) => (
              <DateInput className="w-36" placeholder="Ongoing" value={member.endDate ?? ""} min={member.startDate} onChange={(v) => { if (v !== (member.endDate ?? "")) void updateMember(member._id, { endDate: v || null }); }} />
            ),
          },
          ...moduleColumns.map((c) => ({
            key: `module:${c.id}`,
            header: c.label,
            searchValue: (member: (typeof rows)[number]) => (c.values[member._id] ?? []).join(" "),
            sortValue: (member: (typeof rows)[number]) => (c.values[member._id] ?? []).join(", ") || null,
            exportValue: (member: (typeof rows)[number]) => (c.values[member._id] ?? []).join("; "),
            render: (member: (typeof rows)[number]) => {
              const vs = c.values[member._id] ?? [];
              return vs.length ? <span className="text-xs" title={`From ${c.module}`} data-module-column={c.label}>{vs.join(", ")}</span> : <span className="text-xs text-muted-foreground">None</span>;
            },
          })),
          ...((permissions?.teams.length ?? 0) > 0 ? [{
            key: "teams",
            header: "Teams",
            searchValue: (member: (typeof rows)[number]) => member.teams.join(" "),
            sortValue: (member: (typeof rows)[number]) => member.teams.join(", ") || null,
            exportValue: (member: (typeof rows)[number]) => member.teams.join("; "),
            render: (member: (typeof rows)[number]) => (member.teams.length ? <span className="text-xs">{member.teams.join(", ")}</span> : <span className="text-xs text-muted-foreground">None</span>),
          }] : []),
          {
            key: "login",
            header: "Login",
            sortValue: (member) => member.login.label,
            exportValue: (member) => member.login.label,
            render: (member) => (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs" title={member.login.hint}>{member.login.label}</span>
                {isAdmin && awaitsLogin(member.clerkUserId) && member.isActive && <InviteRowButton member={member} />}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            sortValue: (member) => member.isActive,
            render: (member) => (
              <SelectField
                aria-label={`Status of ${member.name}`}
                value={member.isActive ? "active" : "inactive"}
                disabled={savingId === member._id}
                onValueChange={(v) =>
                  updateMember(member._id, {
                    isActive: v === "active",
                  })
                }
                className={cn(!member.isActive && "text-muted-foreground")}
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
              />
            ),
          },
          ...(isAdmin ? [{
            key: "actions",
            header: "",
            sortable: false,
            exportValue: null,
            render: (member: (typeof rows)[number]) => (
              <div className="flex justify-end gap-1">
                {member._id !== me?._id && member.role !== "admin" && member.isActive && (
                  <button type="button" className={btn} aria-label={`View as ${member.name}`} onClick={() => void viewAs(member)}><Eye className="size-3.5" />View as</button>
                )}
                {member._id !== me?._id && (
                  <button type="button" className={btn} aria-label={`${member.isHidden ? "Unhide" : "Hide"} ${member.name}`} disabled={savingId === member._id}
                    onClick={() => void updateMember(member._id, { isHidden: !member.isHidden }, member.isHidden ? `${member.name} is back on the list` : `${member.name} is hidden`)}>
                    <EyeOff className="size-3.5" />{member.isHidden ? "Unhide" : "Hide"}
                  </button>
                )}
              </div>
            ),
          }] : []),
        ]}
        data={rows}
        rowKey={(member) => member._id}
      />
    </div>
  );
}
