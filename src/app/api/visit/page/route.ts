import { handleVisitPage, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitPage(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
