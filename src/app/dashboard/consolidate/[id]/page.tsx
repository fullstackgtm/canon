import { redirect } from "next/navigation";

/** Old consolidation links go to the Canon field, which sits above every CRM. */
export default async function ConsolidationPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = new URLSearchParams(Object.entries(await searchParams).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]])));
  redirect(`/dashboard/canon-fields/${encodeURIComponent(id)}${query.size ? `?${query}` : ""}`);
}
