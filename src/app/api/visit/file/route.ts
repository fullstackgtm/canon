import { handleVisitFile, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitFile(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
