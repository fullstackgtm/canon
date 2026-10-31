import { VisitReader } from "@/components/modules/visit-reader";

export default async function SharedVisit({ params }: { params: Promise<{ grant: string; path?: string[] }> }) {
  const { grant, path } = await params;
  return <VisitReader grant={grant} path={path?.join("/")} />;
}
