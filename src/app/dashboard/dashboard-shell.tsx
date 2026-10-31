"use client";

import { IntegrationGate } from "@/components/integration-gate";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreateOrganization, UserButton, useOrganization } from "@clerk/nextjs";
import { ChevronRight, Menu, MessageSquare, PanelLeftClose, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { BackgroundActivityDock } from "@/components/background-activity-tray";
import { CustomizeProvider } from "@/components/customize/customize-mode";
import { Logo, LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getActiveSectionLabel,
  isNavItemActive,
} from "@/components/shell/nav";
import { useNavSections } from "@/components/shell/use-nav-sections";
import { AgentOnboardingOverlay, useAgentGate } from "@/components/shell/agent-onboarding";
import { SignupMarketBanner } from "@/components/icps/signup-market-banner";
import { AccessPreviewBanner } from "@/components/shell/access-preview-banner";
import { AskCanon, OPEN_ASK_EVENT } from "@/components/shell/ask-canon";
import { CommandPalette, OPEN_PALETTE_EVENT } from "@/components/shell/command-palette";
import { OnboardingChecklist } from "@/components/shell/onboarding-checklist";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { DevOrgSwitcher, OrgSwitcher } from "@/components/shell/org-switcher";
import { useDueTaskCount } from "@/components/tasks/due-count";
import { RecordInspection } from "@/components/records/record-inspection";
import { WorkspaceTheme } from "@/components/shell/workspace-theme";
import { DevUserButton } from "@/components/shell/dev-member-switcher";
import { useOnboardingSteps } from "@/hooks/use-onboarding-steps";
import { LOCAL_AUTH } from "@/lib/authMode";
import { LocalInviteDialog, LocalOrgSwitcher, LocalUserButton } from "@/components/local-auth-controls";

const DEV_MODE =
  (process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ||
  process.env.NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS === "true";

/** Overdue plus due-today tasks of the signed-in user; nothing when there are none. */
function DueTasksBadge({ collapsed }: { collapsed?: boolean }) {
  const count = useDueTaskCount();
  if (!count) return null;
  return (
    <span
      aria-label={`${count} tasks due`}
      className={cn("bg-primary px-1.5 font-mono text-[10px] text-primary-foreground", collapsed && "absolute right-1 top-0.5")}
    >
      {count}
    </span>
  );
}

const COLLAPSE_KEY = "fsgtm-sidebar-collapsed";

function ShellUserButton({ collapsed }: { collapsed?: boolean }) {
  if (LOCAL_AUTH) return <LocalUserButton collapsed={collapsed} />;
  if (DEV_MODE) return <DevUserButton collapsed={collapsed} />;
  return (
    <UserButton
      showName={!collapsed}
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: cn(!collapsed && "w-full justify-start"),
          userButtonBox: "!flex-row-reverse",
          userButtonOuterIdentifier: "!text-sidebar-foreground/70",
        },
      }}
    />
  );
}

function ShellOrgSwitcher({ collapsed }: { collapsed?: boolean }) {
  if (LOCAL_AUTH) return <LocalOrgSwitcher collapsed={collapsed} />;
  return DEV_MODE ? <DevOrgSwitcher collapsed={collapsed} /> : <OrgSwitcher collapsed={collapsed} />;
}

/** Clerk org gate: with keys configured and no active org, create one inline. */
function RequireOrganization({ children }: { children: React.ReactNode }) {
  const { isLoaded, organization } = useOrganization();
  if (isLoaded && !organization) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-4">
        <CreateOrganization afterCreateOrganizationUrl="/dashboard" skipInvitationScreen />
      </div>
    );
  }
  return <>{children}</>;
}

function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const [closed, setClosed] = useState<Set<string>>(() => new Set());

  // Re-open the section holding the active route on navigation.
  const sections = useNavSections();
  const active = getActiveSectionLabel(pathname, sections);
  useEffect(() => {
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClosed((prev) => {
      if (!prev.has(active)) return prev;
      const next = new Set(prev);
      next.delete(active);
      return next;
    });
  }, [active]);

  const toggle = (label: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <nav className="flex-1 space-y-3 overflow-y-auto px-2 py-3">
      {sections.map((section) => {
        const isOpen = collapsed || !closed.has(section.label);
        const sectionActive = section.label === active;
        return (
          <div key={section.label}>
            {!collapsed && (
              <button
                type="button"
                onClick={() => toggle(section.label)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-2 px-2 py-1 text-xs font-medium text-sidebar-foreground/50 hover:text-sidebar-foreground/70"
              >
                <span
                  className={cn(
                    "size-[7px] shrink-0",
                    sectionActive ? "bg-sidebar-primary" : "bg-sidebar-border",
                  )}
                />
                <span className="flex-1 text-left">{section.label}</span>
                <ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
              </button>
            )}
            {collapsed && <div className="mx-2 mb-1 h-px bg-sidebar-border first:hidden" />}
            {isOpen && (
              <div className="mt-0.5 space-y-0.5">
                {section.items.map((item) => {
                  const isActive = isNavItemActive(pathname, item.href);
                  const link = (
                    <Link
                      href={item.href}
                      aria-label={collapsed ? item.label : undefined}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-2.5 px-2 py-1.5 text-sm transition-colors",
                        collapsed && "justify-center px-0",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                      )}
                    >
                      <item.icon className="size-4 shrink-0" />
                      {!collapsed && <span className="flex-1">{item.label}</span>}
                      {item.badge === "dueTasks" && <DueTasksBadge collapsed={collapsed} />}
                    </Link>
                  );
                  return collapsed ? (
                    <Tooltip key={item.href}>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <div key={item.href}>{link}</div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function AskButton({ collapsed, onOpen }: { collapsed?: boolean; onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.();
        window.dispatchEvent(new Event(OPEN_ASK_EVENT));
      }}
      className={cn(
        "mx-2 mt-2 flex items-center gap-2 border border-sidebar-border px-2 py-1.5 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground/80",
        collapsed && "justify-center px-0",
      )}
      title="Ask Canon (⌘J)"
    >
      <MessageSquare className="size-3.5 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 text-left">Ask Canon</span>
          <kbd className="font-mono text-[10px]">⌘J</kbd>
        </>
      )}
    </button>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const shell = <Suspense><RecordInspection><CustomizeProvider><Shell>{children}</Shell></CustomizeProvider></RecordInspection></Suspense>;
  return LOCAL_AUTH || DEV_MODE ? shell : <RequireOrganization>{shell}</RequireOrganization>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const steps = useOnboardingSteps();
  const gate = useAgentGate(pathname);

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "true");
    } catch {
      // storage unavailable
    }
  }, []);

  const setCollapsedPersist = (v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, String(v));
    } catch {
      // storage unavailable
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Until the user's agent has signed in, the app is greyed out and inert under the agent onboarding overlay. */}
      <div
        className={cn("flex h-dvh overflow-hidden print:block print:h-auto print:overflow-visible", gate.locked && "pointer-events-none select-none opacity-40 grayscale")}
        inert={gate.locked}
        aria-hidden={gate.locked || undefined}
      >
        {/* The first stop for a keyboard: straight to the page, past the navigation. */}
        <a href="#main" className="sr-only z-50 bg-background px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:border focus:border-border">
          Skip to content
        </a>
        {/* Mobile header */}
        <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-sidebar-border bg-sidebar px-4 text-sidebar-foreground md:hidden print:hidden">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2 size-9 text-sidebar-foreground"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
            <Link href="/dashboard">
              <Logo />
            </Link>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-sidebar-foreground"
              aria-label="Search"
              onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
            >
              <Search className="size-5" />
            </Button>
            <ShellUserButton collapsed />
          </div>
        </div>

        {/* Mobile drawer */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="w-[280px] gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
          >
            <SheetTitle className="flex h-14 items-center border-b border-sidebar-border px-4">
              <Logo />
            </SheetTitle>
            <ShellOrgSwitcher />
            <IntegrationGate feature="chatgpt"><AskButton onOpen={() => setMobileOpen(false)} /></IntegrationGate>
            <NotificationsBell />
            {/* One scroll column on a phone: the checklist follows the nav instead of pinning over it. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SidebarNav collapsed={false} />
              <OnboardingChecklist steps={steps} />
            </div>
          </SheetContent>
        </Sheet>

        {/* Desktop sidebar */}
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex print:hidden",
            collapsed ? "w-[60px]" : "w-64",
          )}
        >
          <div
            className={cn(
              "flex h-14 items-center border-b border-sidebar-border px-4",
              collapsed ? "justify-center px-0" : "justify-between",
            )}
          >
            {collapsed ? (
              <button type="button" onClick={() => setCollapsedPersist(false)} aria-label="Expand sidebar">
                <LogoMark size={28} />
              </button>
            ) : (
              <>
                <Link href="/dashboard">
                  <Logo />
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Collapse sidebar"
                  onClick={() => setCollapsedPersist(true)}
                  className="size-8 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                >
                  <PanelLeftClose className="size-4" />
                </Button>
              </>
            )}
          </div>

          <ShellOrgSwitcher collapsed={collapsed} />
          <button type="button" aria-label="Search records and commands" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
            className="mx-2 mt-3 flex h-8 items-center gap-2 border border-sidebar-border px-2 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent">
            <Search className="size-4 shrink-0" />{!collapsed && <><span className="flex-1 text-left">Search and commands</span><kbd className="font-mono text-[10px]">⌘K</kbd></>}
          </button>
          <IntegrationGate feature="chatgpt"><AskButton collapsed={collapsed} /></IntegrationGate>
          <NotificationsBell collapsed={collapsed} />
          <SidebarNav collapsed={collapsed} />

          <OnboardingChecklist steps={steps} collapsed={collapsed} />

          <div className={cn("border-t border-sidebar-border py-3", collapsed ? "flex justify-center" : "px-4")}>
            <ShellUserButton collapsed={collapsed} />
          </div>
        </aside>

        <div className="print:hidden"><BackgroundActivityDock /></div>
        {/* Keep the scroll viewport above the 48px tray launchers and their 16px offsets. */}
        <main className="dashboard-ui relative outline-none mt-14 flex-1 overflow-y-auto bg-background md:mb-20 md:mt-0 print:m-0 print:overflow-visible" id="main" tabIndex={-1}>
          <WorkspaceTheme />
          <AccessPreviewBanner />
          <SignupMarketBanner />
          {children}
        </main>

        {!gate.locked && <CommandPalette />}
        {!gate.locked && <AskCanon />}
      </div>
      {gate.locked && <AgentOnboardingOverlay domain={gate.domain} />}
      {LOCAL_AUTH && <LocalInviteDialog />}
    </>
  );
}
