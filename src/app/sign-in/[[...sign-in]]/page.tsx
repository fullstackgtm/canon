import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { ClerkAuthProvider } from "@/components/convex-provider";

export const dynamic = "force-dynamic";

const DEV_MODE =
  process.env.NODE_ENV !== "production" &&
  !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default async function SignInPage() {
  if (process.env.CANON_AUTH === "local") {
    const { LocalSignIn } = await import("@/components/local-sign-in");
    return <LocalSignIn />;
  }
  if (DEV_MODE) {
    redirect("/dashboard");
  }

  return (
    <ClerkAuthProvider>
      <div className="flex min-h-screen items-center justify-center bg-background">
        <SignIn />
      </div>
    </ClerkAuthProvider>
  );
}
