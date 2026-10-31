import { execSync } from "node:child_process";
const root = process.argv[2];
const sh = (c) => { try { return execSync(c, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }); } catch (e) { return e.stdout || ""; } };
const files = (pat, dirs) => sh(`grep -rlE '${pat}' ${dirs} --include=*.ts --include=*.tsx --include=*.mjs 2>/dev/null`).split("\n").filter(Boolean);
const envKeys = (dirs) => {
  const out = sh(`grep -rhoE 'process\\.env\\.[A-Z0-9_]+' ${dirs} --include=*.ts --include=*.tsx 2>/dev/null`);
  return [...new Set(out.split("\n").filter(Boolean).map((s) => s.replace("process.env.", "")))].sort();
};
const conv = envKeys("convex"), app = envKeys("src");
const vendors = { clerk: /CLERK/, stripe: /STRIPE/, openai: /OPENAI|CHATGPT/, treg: /TREG/, unipile: /UNIPILE/, telnyx: /TELNYX/, google: /GOOGLE/, hubspot: /HUBSPOT/, salesforce: /SALESFORCE|SFDC/, granola: /GRANOLA/, record: /RECORD_SERVICE/, r2s3: /\bR2_|S3_|AWS_/, resend: /RESEND|POSTMARK|SENDGRID/ };
const all = [...new Set([...conv, ...app])];
const byVendor = Object.fromEntries(Object.entries(vendors).map(([k, re]) => [k, all.filter((x) => re.test(x))]));
const claimed = new Set(Object.values(byVendor).flat());
console.log(JSON.stringify({
  clerkImportFiles: files("from .@clerk", "src convex").length,
  convexReactFiles: files("from .convex/react", "src").length,
  hardcodedCanonHosts: files("canoncrm\\.com", "src convex").length,
  hardcodedCanonHostFiles: files("canoncrm\\.com", "src convex").slice(0, 15),
  envKeysConvex: conv.length, envKeysApp: app.length,
  byVendor, unclassified: all.filter((x) => !claimed.has(x)),
}, null, 1));
