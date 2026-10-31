/** Unknown record API paths answer in the error envelope, not the app's HTML 404 page. */
import { errorResponse, V1Error } from "../_lib.ts";

function notFound(request: Request): Response {
  const path = new URL(request.url).pathname;
  return errorResponse(new V1Error("not_found", `No API route ${request.method} ${path}. Records live under /api/v1/records/<object>`));
}

export { notFound as GET, notFound as POST, notFound as PATCH, notFound as PUT, notFound as DELETE };
