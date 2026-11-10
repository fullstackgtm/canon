import { v, type VString } from "convex/values";

declare const sealed: unique symbol;

/** A credential as stored: encrypted with TOKEN_ENCRYPTION_KEY. Only lib/tokenHelpers.ts encryptForStorage makes one. */
export type Sealed = string & { readonly [sealed]: true };

/** The validator of every stored credential field, so a write of a raw string fails the typecheck. */
export const sealedV = v.string() as VString<Sealed>;

/** A cleared credential: a disconnected integration keeps no secret, so there is nothing to encrypt. */
export const NO_CREDENTIAL = "" as Sealed;
