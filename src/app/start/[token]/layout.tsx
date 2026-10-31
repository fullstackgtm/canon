import { ConvexClientProvider } from "@/components/convex-provider";

export const dynamic = "force-dynamic";

export default function StartLayout({ children }: { children: React.ReactNode }) {
  return (
    <ConvexClientProvider>
      <div className="min-h-screen bg-background text-foreground">{children}</div>
    </ConvexClientProvider>
  );
}
