import { handleVisitUpload, visitMethodNotAllowed } from "@/lib/visitHttp";
export async function POST(request: Request) { return handleVisitUpload(request); }
export { visitMethodNotAllowed as GET, visitMethodNotAllowed as OPTIONS };
