import { decryptToken, encryptToken, isEncrypted } from "./encryption";

export async function encryptForStorage(token: string): Promise<string> {
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    return token;
  }
  return encryptToken(token);
}

export async function decryptFromStorage(token: string): Promise<string> {
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    return token;
  }
  if (!isEncrypted(token)) {
    return token;
  }
  return decryptToken(token);
}

/**
 * A mailbox or calendar credential, encrypted for storage, or a refusal: unlike encryptForStorage there is no
 * plain-text fallback, so a deployment without TOKEN_ENCRYPTION_KEY cannot keep one. A feature that stores one
 * lists the key among its required keys (lib/integrationsAvailable.ts), so it is off there to begin with.
 */
export async function encryptCredential(credential: string): Promise<string> {
  if (!process.env.TOKEN_ENCRYPTION_KEY?.trim()) throw new Error("TOKEN_ENCRYPTION_KEY is not set, so this credential is not stored");
  return encryptToken(credential);
}
