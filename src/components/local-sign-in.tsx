import { api } from "../../convex/_generated/api";
import { localAuthBroker } from "@/lib/localAuth";
import { LocalAuthForm } from "./local-auth-form";

export async function LocalSignIn({ invite }: { invite?: string }) {
  const setup = await localAuthBroker().query(api.localAuth.setupNeeded, {});
  return <LocalAuthForm setup={setup} invite={invite} />;
}
