"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useAction, useConvex, useQuery } from "convex/react";
import { Command, defaultFilter } from "cmdk";
import { CornerDownLeft, FileText, Search } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useNavSections } from "./use-nav-sections";
import { groupActivitySearchHits, groupSearchHits, type PaletteRecordGroup } from "./record-search";
import type { ModuleActivitySearchResult } from "../../../modules/kernel/activities";
import { RecordDraftContext, useRecordInspection } from "@/components/records/record-context";
import { getErrorMessage } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 150;

export const OPEN_PALETTE_EVENT = "fsgtm:open-command-palette";

type SearchState = { kind: "loading" } | { kind: "ready"; groups: PaletteRecordGroup[] } | { kind: "failed"; message: string };

function useRecordSearch(query: string, orgId: string | undefined, onAnswer: (groups: PaletteRecordGroup[]) => void, labels: Readonly<Record<string, string>>) {
  const search = useAction(api.objects.search);
  const [answer, setAnswer] = useState<{ q: string; orgId?: string; attempt: number; state: SearchState }>({ q: "", attempt: 0, state: { kind: "ready", groups: [] } });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const q = query.trim();
  useEffect(() => {
    const seq = ++latest.current;
    if (!q || !orgId) return;
    const timer = setTimeout(() => {
      search({ q, limit: 30, perObject: 5 }).then((result) => {
        if (seq !== latest.current) return;
        const groups = groupSearchHits(result.hits, labels);
        setAnswer({ q, orgId, attempt, state: { kind: "ready", groups } });
        onAnswer(groups);
      }, (cause) => {
        if (seq === latest.current) setAnswer({ q, orgId, attempt, state: { kind: "failed", message: getErrorMessage(cause) } });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); if (latest.current === seq) latest.current = seq + 1; };
  }, [q, orgId, search, onAnswer, labels, attempt]);
  const state: SearchState = !q ? { kind: "ready", groups: [] } : answer.q === q && answer.orgId === orgId && answer.attempt === attempt ? answer.state : { kind: "loading" };
  return { state, retry: () => setAttempt((value) => value + 1) };
}

type ActivitySearchState = ModuleActivitySearchResult | { kind: "loading" } | { kind: "failed" };

function useActivitySearch(query: string, orgId: string | undefined) {
  const convex = useConvex();
  const q = query.trim();
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({ q, orgId, attempt }), [q, orgId, attempt]);
  const [answer, setAnswer] = useState<{ request: typeof request; state: ActivitySearchState }>();
  useEffect(() => {
    if (!request.q || !request.orgId) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      const watch = convex.watchQuery(api.moduleActivities.search, { q: request.q, limit: 30 });
      const update = () => {
        if (!active) return;
        let state: ActivitySearchState;
        try { state = watch.localQueryResult() ?? { kind: "loading" }; }
        catch { state = { kind: "failed" }; }
        setAnswer({ request, state });
      };
      unsubscribe = watch.onUpdate(update);
      update();
    }, SEARCH_DEBOUNCE_MS);
    return () => { active = false; clearTimeout(timer); unsubscribe?.(); };
  }, [request, convex]);
  const state: ActivitySearchState = !q ? { kind: "ready", hits: [] } : answer?.request === request ? answer.state : { kind: "loading" };
  return { state, retry: () => setAttempt((value) => value + 1) };
}

// Records are already matched by the server, so cmdk keeps them; pages and commands use its own scoring.
const RECORD = "record:";
const ACTIVITY = "module-activity:";
const paletteFilter = (value: string, search: string, keywords?: string[]) => (value.startsWith(RECORD) || value.startsWith(ACTIVITY) ? 1 : defaultFilter(value, search, keywords));

export type PaletteCommand = {
  id: string;
  label: string;
  group?: string;
  disabled?: boolean;
} & ({ run: () => void; href?: never } | { href: string; run?: never });

// Module-level registry so any page can contribute commands while mounted.
let registered: PaletteCommand[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Add commands to the palette. Returns an unregister function. */
export function registerCommands(cmds: PaletteCommand[]): () => void {
  registered = [...registered, ...cmds];
  emit();
  return () => {
    const ids = new Set(cmds);
    registered = registered.filter((c) => !ids.has(c));
    emit();
  };
}

export function useCommands(commands: PaletteCommand[], scope: "page" | "record" = "page") {
  const inspection = useRecordInspection();
  const latest = useRef(commands);
  useLayoutEffect(() => { latest.current = commands; }, [commands]);
  const inInspection = useContext(RecordDraftContext) !== null;
  const active = !inspection?.target || (scope === "record" && inInspection);
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; }, [active]);
  const shape = JSON.stringify(commands.map(({ id, label, group, disabled, href }) => ({ id, label, group, disabled, href })));
  useEffect(() => {
    if (!active) return;
    return registerCommands(latest.current.map((command): PaletteCommand => {
      if (!command.run) return command;
      return { ...command, run: () => {
        const current = latest.current.find((item) => item.id === command.id);
        if (activeRef.current && !current?.disabled) current?.run?.();
      } };
    }));
  }, [shape, active]);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const getSnapshot = () => registered;
const EMPTY: PaletteCommand[] = [];
const getServerSnapshot = () => EMPTY;

/** Global Cmd/Ctrl+K palette over every dashboard page plus registered commands. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const extra = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [selected, setSelected] = useState("");
  // Results arrive after cmdk has picked its first item, so select the first record when they land.
  const selectFirst = useCallback((groups: PaletteRecordGroup[]) => {
    const first = groups[0]?.records[0];
    if (first) setSelected(`${RECORD}${first.key}`);
  }, []);
  const sections = useNavSections();
  // An org's own objects are named in its registry, not in code: their plural labels head their search groups.
  const customObjects = useQuery(api.customObjects.list);
  const labels = useMemo(() => Object.fromEntries((customObjects ?? []).map((o) => [o.apiName, o.pluralLabel])), [customObjects]);
  const orgId = useQuery(api.users.me)?.orgId;
  const { state: searchState, retry } = useRecordSearch(open ? query : "", orgId, selectFirst, labels);
  const { state: activityState, retry: retryActivities } = useActivitySearch(open ? query : "", orgId);
  const records = searchState.kind === "ready" ? searchState.groups : [];
  const activities = useMemo(() => activityState.kind === "ready" ? groupActivitySearchHits(activityState.hits) : [], [activityState]);
  const missingSelection = selected.startsWith(RECORD)
    ? !records.some((group) => group.records.some((r) => `${RECORD}${r.key}` === selected))
    : selected.startsWith(ACTIVITY) && !activities.some((group) => group.records.some((r) => `${ACTIVITY}${r.key}` === selected));
  const firstActivity = activities[0]?.records[0];
  const currentSelection = !selected || missingSelection ? firstActivity ? `${ACTIVITY}${firstActivity.key}` : "" : selected;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  const commandOwnsFocus = useRef(false);
  const execute = (cmd: PaletteCommand) => {
    if (cmd.disabled) return;
    commandOwnsFocus.current = true;
    setOpen(false);
    setQuery("");
    if (cmd.run) window.setTimeout(cmd.run, 0);
    else if (cmd.href) router.push(cmd.href);
  };

  const extraGroups = new Map<string, PaletteCommand[]>();
  for (const c of extra) {
    const g = c.group ?? "Actions";
    extraGroups.set(g, [...(extraGroups.get(g) ?? []), c]);
  }

  const itemClass =
    "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm text-foreground/80 data-[selected=true]:bg-accent data-[selected=true]:text-foreground data-[disabled=true]:opacity-40";
  const headingClass =
    "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={(next) => (setOpen(next), setQuery(""))}>
      <DialogContent className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}
        onOpenAutoFocus={() => { commandOwnsFocus.current = false; }}
        onCloseAutoFocus={(event) => {
          if (commandOwnsFocus.current) event.preventDefault();
          commandOwnsFocus.current = false;
        }}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command label="Command palette" className="flex flex-col" filter={paletteFilter} value={currentSelection} onValueChange={setSelected}>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-muted-foreground" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search records, jump to a page or run a command…"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="font-mono text-[10px] text-muted-foreground">ESC</kbd>
          </div>
          <Command.List className="max-h-[360px] overflow-y-auto pb-2">
            {searchState.kind === "ready" && activityState.kind === "ready" && (
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                No results.
              </Command.Empty>
            )}
            {searchState.kind === "loading" && <div role="status" aria-live="polite" className="px-3 py-3 text-xs text-muted-foreground">Searching records…</div>}
            {searchState.kind === "failed" && <div role="alert" className="px-3 py-3 text-sm"><p>Record search failed. {searchState.message}</p><button type="button" onClick={retry} className="mt-2 border border-border px-2 py-1 text-xs">Retry search</button></div>}
            {activityState.kind === "loading" && <div role="status" aria-live="polite" className="px-3 py-3 text-xs text-muted-foreground">Searching activities…</div>}
            {activityState.kind === "unavailable" && <div role="status" className="px-3 py-3 text-xs text-muted-foreground">{activityState.message}</div>}
            {activityState.kind === "failed" && <div role="alert" className="px-3 py-3 text-sm"><p>Activity search is unavailable.</p><button type="button" onClick={retryActivities} className="mt-2 border border-border px-2 py-1 text-xs">Retry activity search</button></div>}
            {records.map((group) => (
              <Command.Group key={group.object} heading={group.label} className={headingClass}>
                {group.records.map((r) => (
                  <Command.Item key={r.key} value={`${RECORD}${r.key}`} onSelect={() => execute({ id: r.key, label: r.title, href: r.href })} className={itemClass}>
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{r.title}</span>
                    {r.detail && <span className="ml-auto shrink-0 truncate pl-3 text-xs text-muted-foreground">{r.detail}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
            {activities.map((group) => (
              <Command.Group key={group.object} heading={group.label} className={headingClass}>
                {group.records.map((r) => (
                  <Command.Item key={r.key} value={`${ACTIVITY}${r.key}`} onSelect={() => execute({ id: r.key, label: r.title, href: r.href })} className={itemClass}>
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{r.title}</span>
                    <span className="ml-auto shrink-0 truncate pl-3 text-xs text-muted-foreground">{r.detail}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
            {[...extraGroups].map(([group, cmds]) => (
              <Command.Group key={group} heading={group} className={headingClass}>
                {cmds.map((c) => (
                  <Command.Item disabled={c.disabled} key={c.id} value={`${group} ${c.label} ${c.id}`} onSelect={() => execute(c)} className={itemClass}>
                    <CornerDownLeft className="size-4 text-muted-foreground" />
                    {c.label}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
            {sections.map((section) => (
              <Command.Group key={section.label} heading={section.label} className={headingClass}>
                {section.items.map((item) => (
                  <Command.Item
                    key={item.href}
                    value={`${section.label} ${item.label} ${item.href}`}
                    onSelect={() => execute({ id: item.href, label: item.label, href: item.href })}
                    className={itemClass}
                  >
                    <item.icon className="size-4 text-muted-foreground" />
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
