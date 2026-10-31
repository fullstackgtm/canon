import { handleVisitRequestCode, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitRequestCode(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
