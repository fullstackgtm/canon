import { ConvexClientProvider } from "@/components/convex-provider";
import { IntegrationRoutes } from "@/components/integration-gate";
import { DashboardShell } from "./dashboard-shell";

export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ConvexClientProvider>
      <DashboardShell><IntegrationRoutes>{children}</IntegrationRoutes></DashboardShell>
    </ConvexClientProvider>
  );
}
