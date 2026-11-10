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
