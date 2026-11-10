import { handleVisitVerifyCode, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitVerifyCode(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
