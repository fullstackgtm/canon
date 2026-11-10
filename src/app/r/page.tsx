import { VisitOpen } from "@/components/modules/visit-open";

export default function SharedPageInterstitial() {
  return <main className="mx-auto max-w-lg px-6 py-16"><h1 className="font-display text-2xl">A Canon workspace shared a page with you</h1><p className="mt-4 text-sm text-muted-foreground">Opening this page records your visit for the workspace. A name or email you give later is shown to them as given, without verification.</p><p className="mt-3 text-sm text-muted-foreground">The workspace sees visits and actions as engagement on its deal. If you write later, Canon keeps your IP address and browser as reported by its edge for the workspace’s admins.</p><VisitOpen /></main>;
}
