// Run the simulator as a server until Ctrl-C.
//
//   npm start -- --port 4790 --opportunities 120 --user-emails a@x.example,b@x.example --out /tmp/sim.json
//
// `--out` writes {baseUrl, token, refreshToken, apiVersion} as JSON (mode 600)
// so another process can connect without the token in its argv.
import { writeFileSync } from "node:fs";
import { startSfSim } from "./index.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const num = (name: string) => (arg(name) === undefined ? undefined : Number(arg(name)));

const sim = await startSfSim({
  port: num("port"),
  seed: num("seed"),
  accounts: num("accounts"),
  contacts: num("contacts"),
  leads: num("leads"),
  opportunities: num("opportunities"),
  users: num("users"),
  customRecords: num("custom-records"),
  userEmails: arg("user-emails")?.split(",").filter(Boolean),
});
const out = arg("out");
const info = { baseUrl: sim.baseUrl, token: sim.token, refreshToken: sim.refreshToken, apiVersion: sim.apiVersion };
if (out) writeFileSync(out, JSON.stringify(info), { mode: 0o600 });
console.log(`sf-sim listening on ${sim.baseUrl}`);
const stop = () => {
  console.log(`sf-sim stopping: ${sim.calls().length} API calls, ${sim.writeCount()} of them writes`);
  void sim.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
