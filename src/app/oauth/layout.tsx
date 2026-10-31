import { ConvexClientProvider } from "@/components/convex-provider";

export const dynamic = "force-dynamic";

export default function OAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConvexClientProvider>{children}</ConvexClientProvider>;
}
