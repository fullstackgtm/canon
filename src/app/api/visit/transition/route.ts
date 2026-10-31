import { handleVisitTransition, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitTransition(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
