// Loaded into the Convex backend's Node action runner through NODE_OPTIONS (backendEnv in platform.mjs). The runner's
// calls back into Convex, and a Node action's own fetch of a Convex URL, go to the backend's in-container address.
import { internalUrl } from "../../src/lib/internalUrl.ts";

const env = { ...process.env };
const fetchAsGiven = globalThis.fetch;

globalThis.fetch = (input, init) => {
  if (input instanceof Request) {
    const url = internalUrl(input.url, env);
    return fetchAsGiven(url === input.url ? input : new Request(url, input), init);
  }
  return fetchAsGiven(internalUrl(String(input), env), init);
};
