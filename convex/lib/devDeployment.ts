/** The development deployment behind dev.canoncrm.com. Production is never listed. */
export const DEV_DEPLOYMENT = "https://development-example.convex.cloud";

/** Whether this backend is the dev deployment or a local one, read from CONVEX_CLOUD_URL. Production's differs. */
export function isDevOrLocalDeployment(env: Record<string, string | undefined>): boolean {
  const cloudUrl = env.CONVEX_CLOUD_URL?.trim().replace(/\/+$/, "") ?? "";
  if (cloudUrl === DEV_DEPLOYMENT) return true;
  try {
    const { hostname } = new URL(cloudUrl);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}
