/**
 * The "Acme Analytics" fixture (docs/module-plans/customer-success.md §12): six customers' deals, every one recurring
 * for 12 months and won unless it says. The engine goldens read it as deals, and `devSeed:seedCustomerSuccess` writes
 * the same rows into a local stack, so the Retention page and the tests check one set of numbers.
 */
export type AcmeDeal = {
  key: string; company: string; name: string; type: "new_business" | "renewal" | "expansion"; close: string;
  /** Whole dollars. */
  arr: number;
  status: "won" | "lost" | "commit" | "best_case";
};

export const ACME_COMPANIES = [
  { company: "initech", name: "Initech", domain: "initech.example" },
  { company: "umbrella", name: "Umbrella", domain: "umbrella.example" },
  { company: "northwind", name: "Northwind", domain: "northwind.example" },
  { company: "globex", name: "Globex", domain: "globex.example" },
  { company: "soylent", name: "Soylent", domain: "soylent.example" },
  { company: "hooli", name: "Hooli", domain: "hooli.example" },
] as const;

export const ACME_DEALS: readonly AcmeDeal[] = [
  { key: "initech-2025", company: "initech", name: "Initech 2025", type: "new_business", close: "2025-07-01", arr: 40_000, status: "won" },
  { key: "initech-renewal", company: "initech", name: "Initech renewal", type: "renewal", close: "2026-07-01", arr: 40_000, status: "lost" },
  { key: "umbrella-2025", company: "umbrella", name: "Umbrella 2025", type: "new_business", close: "2025-08-01", arr: 80_000, status: "won" },
  { key: "umbrella-renewal", company: "umbrella", name: "Umbrella renewal", type: "renewal", close: "2026-08-01", arr: 64_000, status: "won" },
  { key: "northwind-2025", company: "northwind", name: "Northwind 2025", type: "new_business", close: "2025-10-01", arr: 120_000, status: "won" },
  { key: "northwind-renewal", company: "northwind", name: "Northwind renewal", type: "renewal", close: "2026-10-01", arr: 132_000, status: "won" },
  { key: "globex-2025", company: "globex", name: "Globex 2025", type: "new_business", close: "2025-11-15", arr: 60_000, status: "won" },
  { key: "globex-renewal", company: "globex", name: "Globex renewal", type: "renewal", close: "2026-11-15", arr: 60_000, status: "commit" },
  { key: "soylent-2025", company: "soylent", name: "Soylent 2025", type: "new_business", close: "2025-12-20", arr: 30_000, status: "won" },
  { key: "soylent-renewal", company: "soylent", name: "Soylent renewal", type: "renewal", close: "2026-12-20", arr: 30_000, status: "best_case" },
  { key: "hooli-2026", company: "hooli", name: "Hooli 2026", type: "new_business", close: "2026-02-01", arr: 50_000, status: "won" },
  { key: "hooli-seats", company: "hooli", name: "Hooli seats", type: "expansion", close: "2026-05-01", arr: 25_000, status: "won" },
];
