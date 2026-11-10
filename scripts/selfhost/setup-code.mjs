// Prints the setup code that creates this install's first owner. Run it inside the container:
//   docker compose exec canoncrm node scripts/selfhost/setup-code.mjs
import { readFileSync } from "node:fs";
import { SETUP_CODE_FILE } from "./platform.mjs";

try {
  console.log(process.env.CANON_SETUP_CODE?.trim() || readFileSync(SETUP_CODE_FILE, "utf8").trim());
} catch {
  console.error("No setup code yet. Start the container once, then run this again.");
  process.exitCode = 1;
}
