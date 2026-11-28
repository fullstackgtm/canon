import { describeLayout as describeLayoutForStandIn, type Layout, type LayoutOp } from "../../recipes/md/edit.ts";
import type { PageStyle } from "../../recipes/layout.ts";
import type { ObjectDef } from "./objects/registry.ts";
import type { RecordProps } from "../../recipes/blocks.ts";
import { visibleRecordFields } from "../../recipes/recordFields.ts";
import { parentRecordRelations } from "../../recipes/recordRelations.ts";

const SALESFORCE_STYLE = { density: "compact", surface: "bordered", headerBand: "tinted", accent: "#0176d3" } satisfies PageStyle;
const SALESFORCE_ACTIVITY = { composer: ["note", "task", "call"], group: "upcomingOverdue" } satisfies RecordProps<"activity">;

export function standInReferenceLayout(layout: Layout, request: string, objects?: ObjectDef[]): LayoutOp[] | null {
  if (layout.object !== "deal" || !/\bsalesforce\b/i.test(request)) return null;
  const object = "deal";
  const style: LayoutOp = { op: "setPageStyle", object, style: { ...layout.style, ...SALESFORCE_STYLE } };
  const hasStyle = Object.entries(SALESFORCE_STYLE).every(([key, value]) => layout.style?.[key as keyof PageStyle] === value);
  const currentInfo = layout.sections.find((section) => section.component === "fieldSection" && (section.props as RecordProps<"fieldSection">).title === "Opportunity information");
  const fields = layout.sections.filter((section) => section.component === "fields").map((section) => section.ref);
  const legacyTimeline = layout.sections.filter((section) => section.component === "timeline").map((section) => section.ref).reverse();
  const tabs = (activity: { component: "activity"; nth: number }, info?: Layout["sections"][number]["ref"]): LayoutOp => ({
    op: "wrapSections", object, sections: info ? [info, activity] : [activity], kind: "tabs", id: "recordTabs",
    props: { labels: info ? ["Details", "Activity"] : ["Activity"], variant: "underline" },
  });
  const addActivity = (before: Layout["sections"][number]["ref"] | null): LayoutOp => ({
    op: "addSection", object, before, component: "activity", title: "Activity", props: SALESFORCE_ACTIVITY,
  });
  if (currentInfo) {
    if (!layout.sections.some((section) => section.component === "activity")) {
      return [
        addActivity(currentInfo.ref), tabs({ component: "activity", nth: 0 }, currentInfo.ref),
        { op: "wrapSections", object, sections: [currentInfo.ref], kind: "stack", id: "opportunityDetails" },
        ...fields.map((section): LayoutOp => ({ op: "moveIntoContainer", object, section, container: "opportunityDetails", before: null })),
        ...legacyTimeline.map((section): LayoutOp => ({ op: "removeSection", object, section })),
        ...(!hasStyle ? [style] : []),
      ];
    }
    return hasStyle ? [] : [style];
  }
  const highlightIndex = layout.sections.findIndex((section) => section.component === "highlights");
  const highlights = layout.sections[highlightIndex];
  const before = layout.sections[highlightIndex + 1]?.ref ?? null;
  const names = (object: string, defaults: string[]) => objects
    ? visibleRecordFields(objects.find((def) => def.apiName === object)?.fields ?? [], defaults).map((field) => field.apiName)
    : defaults;
  const infoFields = names("deal", ["name", "ownerId", "companyId", "stage", "amount", "closeDate"]);
  const accountFields = names("account", ["name", "domain", "industry", "status", "ownerId"]);
  const showParent = accountFields.length > 0 && (!objects || parentRecordRelations(object, objects).some((p) => p.id === "dealCompany"));
  const hasHighlightsActions = (highlights?.props as RecordProps<"highlights"> | undefined)?.actions?.length || highlights?.actions.length;
  const next = <K extends "fieldSection" | "relatedRecord" | "relatedList" | "activity">(component: K) => ({ component, nth: layout.sections.slice(0, highlightIndex + 1).filter((s) => s.component === component).length });
  const info = next("fieldSection");
  const activity = next("activity");
  const parent = next("relatedRecord");
  const related = next("relatedList");
  const ops: LayoutOp[] = [
    ...(!highlights ? [{ op: "addSection", object, before, component: "highlights", title: "Highlights", props: {} } as const] : []),
    ...(!hasHighlightsActions && !layout.sections.some((s) => s.component === "actionBar")
      ? [{ op: "addSection", object, before, component: "actionBar", title: "Record actions", props: { actions: ["kernel.archive", "kernel.restore"] } } satisfies LayoutOp] : []),
    ...(!layout.sections.some((s) => s.component === "path")
      ? [{ op: "addSection", object, before, component: "path", title: "Pipeline path", props: { change: true } } as const] : []),
    ...(!layout.sections.some((s) => s.component === "quickLinks")
      ? [{ op: "addSection", object, before, component: "quickLinks", title: "Related links", props: { relationships: ["companyDeals", "companyPeople", "dealPeople"] } } satisfies LayoutOp] : []),
    ...(infoFields.length ? [{ op: "addSection", object, before, component: "fieldSection", title: "Opportunity information",
      props: { title: "Opportunity information", fields: infoFields, columns: 2 } } satisfies LayoutOp] : []),
    addActivity(before),
    ...(showParent ? [{ op: "addSection", object, before, component: "relatedRecord", title: "Account details",
      props: { relationship: "dealCompany", fields: accountFields } } satisfies LayoutOp] : []),
    { op: "addSection", object, before, component: "relatedList", title: "Opportunities at this account",
      props: { relationship: "companyDeals", columns: ["recordTitle", ...names("deal", ["stage", "amount"])], create: true } },
  ];
  if (!highlights && before?.component === "header") ops.push({ op: "removeSection", object, section: before });
  if (infoFields.length) {
    const right = showParent ? parent : related;
    ops.push(
      { op: "wrapSections", object, sections: [info, right], kind: "columns", id: "recordColumns", props: { widths: [2, 1], gap: "tight" } },
      { op: "wrapSections", object, sections: [info], kind: "stack", id: "recordMain" },
      { op: "moveIntoContainer", object, section: activity, container: "recordMain", before: null },
      tabs(activity, info),
    );
    if (fields.length) {
      ops.push({ op: "wrapSections", object, sections: [info], kind: "stack", id: "recordFields" });
      for (const section of fields) ops.push({ op: "moveIntoContainer", object, section, container: "recordFields", before: null });
    }
    if (showParent) ops.push(
      { op: "wrapSections", object, sections: [parent], kind: "stack", id: "recordRelated" },
      { op: "moveIntoContainer", object, section: related, container: "recordRelated", before: null },
    );
  } else ops.push(tabs(activity));
  for (const section of legacyTimeline) ops.push({ op: "removeSection", object, section });
  return [...ops, style];
}

export function standInWorkflow(input: import("./workflowAgent.ts").WorkflowInput) {
  const dealPage = input.pages.find((p) => p.target === "deal");
  if (dealPage && (!input.imageReference?.currentTarget || input.imageReference.currentTarget === "deal") && /\bsalesforce\b/i.test(input.request)) {
    const layout = describeLayoutForStandIn(dealPage.markdown, "deal");
    const ops = !("error" in layout) ? standInReferenceLayout(layout, input.request, input.objects) : null;
    if (ops?.length === 0) return { plan: [], ops: {}, summary: "The deal page already has the Salesforce layout and style." };
    if (ops?.length) return { plan: [{ target: "deal", why: "Bring pipeline progress and related records together." }],
      ops: { deal: ops }, summary: ops.length === 1
        ? "Applied compact spacing, bordered cards, a tinted header and a blue accent."
        : "Organized opportunity details and activity into tabs alongside related records, with compact spacing and a blue accent." };
  }
  if (/\badd\b.*\bstage rail\b/i.test(input.request)) {
    const deal = input.pages.find((p) => p.target === "deal");
    const layout = deal && describeLayoutForStandIn(deal.markdown, "deal");
    if (layout && !("error" in layout)) {
      return {
        plan: [{ target: "deal", why: "See the deal's progress at a glance." }],
        ops: { deal: [{ op: "addSection", object: "deal", component: "stageRail", title: "Stage rail", before: layout.sections[1]?.ref ?? null }] },
        summary: "Added the Stage rail directly below the deal header.",
      };
    }
  }
  const sdr = /SDR|morning.queue/i.test(input.request);
  if (!sdr && !/renewal/i.test(input.request)) return { plan: [], ops: {}, summary: "The local stand-in handles Salesforce-style deal layouts, renewals desks and SDR morning queues." };
  const target = sdr ? "morning-queue" : "renewals";
  const existing = input.pages.find((p) => p.target === target);
  const plan: import("./workflowAgent.ts").WorkflowPlan[] = [{ target, ...(existing ? {} : { create: { slug: target, title: sdr ? "Morning queue" : "Renewals desk" } }), why: sdr ? "Start the day with contacts; open a person to log a call." : "Review approaching renewals or, without a contract date, open deals by close date." }];
  const accounts = input.objects.find((o) => o.apiName === "account");
  const date = accounts?.fields.find((f) => ["date", "datetime"].includes(f.type) && /contract|renewal/i.test(f.apiName));
  const object = sdr ? "contact" : date ? "account" : "deal";
  const def = input.objects.find((o) => o.apiName === object);
  const title = def?.fields.find((f) => f.fieldId === def.titleFieldId)?.apiName ?? def?.fields[0]?.apiName ?? "recordTitle";
  const close = date?.apiName ?? "closeDate";
  const query = { object, filter: sdr ? [] : date ? [{ field: close, op: "gte" as const, value: new Date().toISOString().slice(0, 10) }, { field: close, op: "lte" as const, value: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) }] : [{ field: "isClosed", op: "eq" as const, value: false }], columns: [title, ...(!sdr ? [close] : [])], ...(!sdr ? { sort: { field: close, dir: "asc" as const } } : {}), limit: 50 };
  const ops: Record<string, LayoutOp[]> = { [target]: [{ op: "addSection", object: target, component: sdr ? "list" : "table", title: sdr ? "People to contact" : "Upcoming renewals", before: null, query }] };
  if (!sdr) ops[target].push({ op: "addSection", object: target, component: "metric", title: "In queue", before: null, query: { object, filter: query.filter, aggregate: { fn: "count" }, limit: 50 } });
  if (sdr) {
    const contact = input.pages.find((p) => p.target === "contact");
    const layout = contact && describeLayoutForStandIn(contact.markdown, "contact");
    if (layout && !("error" in layout)) {
      plan.push({ target: "contact", why: "Log a call near the top and fold a secondary section." });
      const call = input.objects.find((o) => o.apiName === "call");
      const fields = call?.fields.filter((f) => !f.system && ["subject", "body", "description", "callAt", "notes"].includes(f.apiName)).map((f) => f.apiName) ?? [];
      const taken = new Set(layout.sections.flatMap((s) => s.actions.map((a) => a.id)));
      let createId = "form";
      for (let n = 2; taken.has(createId); n++) createId = `form${n}`;
      const form = { component: "form" as const, nth: layout.sections.filter((s) => s.component === "form").length };
      ops.contact = [{ op: "addSection", object: "contact", component: "form", title: "Log a call", before: layout.sections[1]?.ref ?? null, query: { object: "call", filter: [], fields: fields.length ? fields : ["subject"], defaults: {}, limit: 10 } }, { op: "addAction", object: "contact", section: form, runs: "kernel.logActivity", label: "Log call" }, { op: "removeAction", object: "contact", section: form, action: createId }];
      const secondary = layout.sections.find((s) => s.component === "fields") ?? layout.sections.at(-1);
      if (secondary) ops.contact.push({ op: "setCollapsed", object: "contact", section: secondary.ref, collapsed: true });
    }
  }
  return { plan, ops, summary: sdr ? "Added a morning queue and a call form on contact records; folded contact details." : date ? "Added renewals due in 90 days and a count." : "No contract renewal date is available; added open deals by close date and a count." };
}
