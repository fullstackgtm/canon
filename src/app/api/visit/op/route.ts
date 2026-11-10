import { handleVisitOp, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitOp(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
