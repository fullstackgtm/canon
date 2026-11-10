export const LOCAL_AUTH = process.env.NEXT_PUBLIC_CANON_AUTH === "local";
export const LOCAL_SESSION_COOKIE = "canon_session";

export function localAuthPublicPath(path: string) {
  return path === "/api/local-auth" || path === "/" || path === "/sign-in" ||
    path.startsWith("/sign-in/") || path === "/sign-up" || path.startsWith("/sign-up/");
}
