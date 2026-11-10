import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import { api } from "../../../../convex/_generated/api";
import { plainConvexClient } from "../../api/cli/_lib";
import { ClerkAuthProvider } from "@/components/convex-provider";

export const dynamic = "force-dynamic";

const DEV_MODE =
  process.env.NODE_ENV !== "production" &&
  !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (process.env.CANON_AUTH === "local") {
    const { LocalSignIn } = await import("@/components/local-sign-in");
    return <LocalSignIn invite={typeof params.invite === "string" ? params.invite : undefined} />;
  }
  const inviteCookie = (await cookies()).get("fsgtm_invite")?.value;
  const research =
    typeof params.research === "string" ? params.research : inviteCookie;
  const session = research
    ? await plainConvexClient().query(api.researchSessions.get, {
        token: research,
      })
    : null;
  if (session?.invited && research && inviteCookie !== research)
    redirect(`/api/lead-magnet/invite?token=${encodeURIComponent(research)}`);
  if (!params.__clerk_ticket && !session?.invited)
    redirect(research ? `/start/${research}?phase=waitlist` : "/");
  if (DEV_MODE) {
    redirect("/dashboard");
  }
  // A workspace invite (users.invite) lands here. Clerk marks an invitee who already has an account with
  // __clerk_status=sign_in: their ticket is redeemed by signing in, so hand the same query to /sign-in.
  if (params.__clerk_status === "sign_in") {
    const query = new URLSearchParams(
      Object.entries(params).flatMap(([k, v]) =>
        typeof v === "string" ? [[k, v]] : [],
      ),
    );
    redirect(`/sign-in?${query}`);
  }

  return (
    <ClerkAuthProvider>
      <div className="flex min-h-screen items-center justify-center bg-background">
        <SignUp
          routing="hash"
          forceRedirectUrl={
            session?.invited ? `/start/${research}/claim` : undefined
          }
        />
      </div>
    </ClerkAuthProvider>
  );
}
