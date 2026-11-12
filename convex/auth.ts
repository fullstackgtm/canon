import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import { createOrUpdateUser } from "./convexAuthUsers";

const enabled = process.env.CANON_AUTH === "convex";
const emailEnabled = Boolean(process.env.AUTH_RESEND_KEY && process.env.AUTH_EMAIL_FROM);
const email = Resend({
  apiKey: process.env.AUTH_RESEND_KEY, from: process.env.AUTH_EMAIL_FROM,
  async sendVerificationRequest({ identifier, url, token, provider }) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: provider.from, to: identifier, subject: "Your CanonCRM sign-in code", text: provider.id === "resend" ? `Your code is ${token}\n\nSign in: ${url}` : `Your password reset code is ${token}` }),
    });
    if (!response.ok) throw new Error("Could not send authentication email");
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: enabled ? [
    Password({
      profile(params) {
        const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
        return { email };
      },
      ...(emailEnabled ? { reset: Resend({ ...email.options, id: "password-reset" }) } : {}),
    }),
    ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET ? [Google({
      clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET,
      profile(profile) { return { id: profile.sub, name: profile.name, email: profile.email, image: profile.picture, emailVerified: profile.email_verified === true }; },
    })] : []),
    ...(emailEnabled ? [email] : []),
  ] : [],
  callbacks: { createOrUpdateUser },
});
