/**
 * Signal watches (docs/signal-automations.md): a yes-or-no question asked of each account on a schedule, and a rule
 * that acts when the answer turns yes. This is the starter catalog; a person can also write their own question.
 * Pure data: no Convex imports.
 */

export type SignalTemplate = {
  key: string;
  label: string;
  /** Asked of one account at a time, answered from public pages with quotes. */
  question: string;
  /** What the account owner is asked to do when it turns yes. */
  task: string;
  group: "hiring" | "leadership" | "money" | "strategy" | "risk";
};

export const SIGNAL_TEMPLATES: readonly SignalTemplate[] = [
  {
    key: "hiring_sales", group: "hiring", label: "Hiring sales reps",
    question: "Has this company posted three or more open sales roles (SDR, BDR, account executive or sales leadership) in the last 30 days, on its careers page or job boards?",
    task: "They're building a sales team: reach the sales leader",
  },
  {
    key: "hiring_revops", group: "hiring", label: "Hiring RevOps",
    question: "Has this company posted an open revenue operations, sales operations or GTM systems role in the last 30 days?",
    task: "They're hiring RevOps: reach the head of sales or operations",
  },
  {
    key: "new_sales_leader", group: "leadership", label: "New sales leader",
    question: "Has this company hired or announced a new CRO, VP of Sales or head of sales in the last 90 days?",
    task: "New sales leader: reach them in their first 90 days",
  },
  {
    key: "new_marketing_leader", group: "leadership", label: "New marketing leader",
    question: "Has this company hired or announced a new CMO, VP of Marketing or head of growth in the last 90 days?",
    task: "New marketing leader: reach them in their first 90 days",
  },
  {
    key: "raised_funding", group: "money", label: "Raised funding",
    question: "Has this company announced a funding round, or filed an SEC Form D, in the last 90 days?",
    task: "They just raised: reach them while budgets are set",
  },
  {
    key: "acquisition", group: "money", label: "Acquired or acquiring",
    question: "Has this company acquired another company, or announced it is being acquired, in the last 90 days?",
    task: "M&A: check who now owns the decision",
  },
  {
    key: "expansion", group: "strategy", label: "Expanding",
    question: "Has this company announced a new office, a new country or market, or a new product line in the last 90 days?",
    task: "They're expanding: tie your pitch to the new market",
  },
  {
    key: "ai_initiative", group: "strategy", label: "AI initiative",
    question: "Has this company's leadership publicly described a new AI initiative or AI budget (in a post, interview, filing or earnings call) in the last 90 days?",
    task: "Leadership is investing in AI: reach the initiative's owner",
  },
  {
    key: "layoffs", group: "risk", label: "Layoffs",
    question: "Has this company announced layoffs or a reduction in force in the last 90 days?",
    task: "Layoffs announced: check the account's risk and your champion",
  },
];

export const signalTemplate = (key: string): SignalTemplate | undefined => SIGNAL_TEMPLATES.find((t) => t.key === key);

export const SIGNAL_PREFIX = "Signal: ";

/** The AI field's name for a signal, which also marks it as one. */
export const signalFieldLabel = (label: string): string => `${SIGNAL_PREFIX}${label.trim()}`.slice(0, 80);
