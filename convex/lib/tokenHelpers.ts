import { ConvexError } from "convex/values";
import { decryptToken, encryptToken, isEncrypted } from "./encryption";
import { NO_CREDENTIAL, type Sealed } from "./sealed";

/**
 * A credential (an OAuth or API token, a webhook URL or signing secret), encrypted for storage. Every install has
 * TOKEN_ENCRYPTION_KEY (every setup path generates one), so a deployment without it refuses to keep a credential
 * rather than keep it readable. An empty value clears a credential and needs no key.
 */
export async function encryptForStorage(token: string): Promise<Sealed> {
  if (!process.env.TOKEN_ENCRYPTION_KEY?.trim()) {
    if (token === "") return NO_CREDENTIAL;
    throw new ConvexError("TOKEN_ENCRYPTION_KEY is not set, so Canon will not store this credential. See \"Keep the token encryption key\" in docs/self-hosting.md.");
  }
  return (await encryptToken(token)) as Sealed;
}

/** A stored credential in the clear. A value kept in plain text before every install had a key reads as it is. */
export async function decryptFromStorage(token: string): Promise<string> {
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    return token;
  }
  if (!isEncrypted(token)) {
    return token;
  }
  return decryptToken(token);
}
