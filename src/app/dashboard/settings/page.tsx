"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, ChevronRight } from "lucide-react";
import { ViewFrame } from "@/components/dashboard";
import { cn } from "@/lib/utils";
import { SETTINGS_GROUPS, isSettingsKey, legacyTabHref, settingsDef, type SettingsKey } from "./catalog";
import { useSettingsAccess, useSettingsSummaries, type SettingsSummary } from "./settings-ui";

/**
 * Settings: one row per area, like Integrations. Selecting a row shows its facts in the right rail with the way into
 * its own page. AI is on Integrations, pipelines and the data model on Recipes, automations on Agents.
 */
function SettingsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const access = useSettingsAccess();
  const summaries = useSettingsSummaries();

  // Old ?tab= links (Stripe returns, onboarding, emails) go to where that tab lives now.
  const legacy = legacyTabHref(searchParams.get("tab"), searchParams);
  useEffect(() => {
    if (legacy) router.replace(legacy);
  }, [legacy, router]);

  const groups = SETTINGS_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => !item.adminOnly || access.isAdmin) })).filter(
    (group) => group.items.length,
  );
  const requested = searchParams.get("selected");
  const selected: SettingsKey = isSettingsKey(requested) && groups.some((g) => g.items.some((i) => i.key === requested)) ? requested : "workspace";
  const select = (key: SettingsKey) => router.replace(`${pathname}?selected=${key}`, { scroll: false });

  return (
    <ViewFrame title="Settings">
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <nav className="overflow-hidden border border-border bg-card" aria-label="Settings">
          <div aria-hidden className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span>Area</span>
            <span className="pr-7">Now</span>
          </div>
          {groups.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="eyebrow border-b border-border bg-muted/40 px-4 py-1.5 text-muted-foreground">{group.title}</h3>
              {group.items.map((item) => {
                const active = item.key === selected;
                const value = summaries[item.key].value;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    data-testid={`settings-row-${item.key}`}
                    onClick={() => select(item.key)}
                    onDoubleClick={() => router.push(item.href)}
                    className={cn(
                      "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50",
                      active && "bg-muted/70 shadow-[inset_2px_0_0_var(--primary)]",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.summary}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      {value === undefined ? (
                        <span className="h-3 w-20 animate-pulse bg-muted" />
                      ) : (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">{value}</span>
                      )}
                      <ChevronRight className={cn("h-4 w-4 text-muted-foreground/60", active && "text-foreground")} />
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>

        <SettingsRail area={selected} summary={summaries[selected]} />
      </div>
    </ViewFrame>
  );
}

/** The right rail: what the selected area covers, where it stands, and the way into its page. */
function SettingsRail({ area, summary }: { area: SettingsKey; summary: SettingsSummary }) {
  const def = settingsDef(area);
  return (
    <aside aria-label={`${def.name} details`} className="border border-border bg-card lg:sticky lg:top-28" data-testid="settings-rail">
      <div className="px-5 py-5">
        <h2 className="text-lg font-semibold">{def.name}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{def.description}</p>
        <Link
          href={def.href}
          data-testid={`settings-open-${area}`}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
        >
          Open {def.name} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      {summary.facts.length > 0 && (
        <section className="border-t border-border px-5 py-4">
          <h3 className="eyebrow mb-3 text-muted-foreground">Now</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {summary.facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </aside>
  );
}

export default function SettingsIndexPage() {
  return (
    <Suspense fallback={<ViewFrame title="Settings"><p className="text-sm text-muted-foreground">Loading settings...</p></ViewFrame>}>
      <SettingsContent />
    </Suspense>
  );
}
