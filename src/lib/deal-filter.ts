export type DealStatus = "open" | "won" | "lost";

export const DEAL_FILTER_DEFAULTS = { status: "open", q: "" };
export type DealFilter = typeof DEAL_FILTER_DEFAULTS;

export const DEAL_STATUSES: ReadonlyArray<{ key: DealStatus | "all"; label: string }> = [
  { key: "open", label: "Open" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  { key: "all", label: "All" },
];

export const dealStatusOf = (deal: { isClosed: boolean; isWon?: boolean }): DealStatus => (!deal.isClosed ? "open" : deal.isWon ? "won" : "lost");

export const matchesDealStatus = (status: string | undefined, deal: { isClosed: boolean; isWon?: boolean }) =>
  status === "all" || dealStatusOf(deal) === (status || DEAL_FILTER_DEFAULTS.status);

export const isDefaultDealFilter = (state: Partial<DealFilter>) => !state.q && (state.status || DEAL_FILTER_DEFAULTS.status) === DEAL_FILTER_DEFAULTS.status;
