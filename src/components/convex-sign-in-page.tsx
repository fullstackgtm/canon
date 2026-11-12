import { ConvexClientProvider } from "./convex-provider";
import { ConvexSignIn } from "./convex-sign-in";

export function ConvexSignInPage() {
  return <ConvexClientProvider waitForAuth={false}><ConvexSignIn
    google={Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET)}
    emailEnabled={Boolean(process.env.AUTH_RESEND_KEY && process.env.AUTH_EMAIL_FROM)}
  /></ConvexClientProvider>;
}
