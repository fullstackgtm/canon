export function convexAuthError(error: unknown, flow: string, google: boolean, emailEnabled: boolean): string {
  const generic = "Sign-in failed. Check your details and try again.";
  if (flow !== "signUp" || !error || typeof error !== "object" || !("data" in error)) return generic;
  const reason = error.data;
  if (reason === "Verify this email before linking an existing member. Use email sign-in or Google.") {
    const methods = [google && "Google", emailEnabled && "an emailed code"].filter(Boolean);
    return methods.length
      ? `Verify your email to sign in as this workspace member. Use ${methods.join(" or ")} with the same email address.`
      : "Your email must be verified to sign in as this workspace member. This install has no sign-in method that can verify it. Ask your workspace admin.";
  }
  if (reason === "Sign in with your password or reset it before linking another sign-in method.") {
    return emailEnabled ? "Sign in with your password or reset it before linking another sign-in method." : "Sign in with your password before linking another sign-in method. If you cannot, ask your workspace admin.";
  }
  if (typeof reason === "string" && reason.startsWith("Multiple members use this email.")) {
    return "Multiple workspace members use this email address. Ask your workspace admin to resolve them.";
  }
  return generic;
}
