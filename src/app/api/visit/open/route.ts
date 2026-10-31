import { handleVisitOpen, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitOpen(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
