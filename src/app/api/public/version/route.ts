// Which commit this deployment is serving. The deploy workflows poll this to
// confirm the exact SHA they shipped is live (.github/workflows/deploy-*.yml).
// Public and cache-free; exposes nothing beyond the commit and environment name.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      sha: process.env.RELEASE_GIT_SHA ?? null,
      environment: process.env.APP_ENVIRONMENT ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
