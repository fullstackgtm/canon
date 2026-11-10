// The contributor license agreement check for pull requests on the public repository (CLA.md).
// .github/workflows/cla.yml runs it from the base branch under pull_request_target, so a pull request can't
// change the check. It reads the author's signature file through the API as data, with the read-only default
// token, and never checks out or runs the pull request's code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AGREEMENT = "I agree to the Canon Contributor License Agreement in CLA.md, version 1.";
// The company's own accounts. The publisher account also opens the automated canon-sync/* pull requests.
export const MAINTAINERS = ["ryanfsgtm"];
const SYNC_ACCOUNT = "ryanfsgtm";

export const signaturePath = (login) => `contributors/${login.toLowerCase()}.md`;

/** Whether `text` is a signature file for `login`: the agreement sentence, a name, the login and a date. */
export function validSignature(text, login) {
  if (typeof text !== "string") return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const field = (name) => lines.find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim() ?? "";
  return lines.includes(AGREEMENT) && field("Name") !== "" && field("GitHub").toLowerCase() === login.toLowerCase() && /^\d{4}-\d{2}-\d{2}$/.test(field("Date"));
}

/**
 * Whether a pull request may merge under the agreement. `base` and `head` are the author's signature file on the
 * base branch and in the pull request (null when absent).
 * @param {{ author: string, repository: string, headRepository: string | null, headRef: string, base: string | null, head: string | null }} pr
 */
export function claDecision({ author, repository, headRepository, headRef, base, head }) {
  if (author === SYNC_ACCOUNT && headRepository === repository && headRef.startsWith("canon-sync/")) return { ok: true, reason: "automated sync" };
  if (MAINTAINERS.includes(author.toLowerCase())) return { ok: true, reason: "maintainer" };
  if (validSignature(base, author)) return { ok: true, reason: `signed in ${signaturePath(author)}` };
  if (validSignature(head, author)) return { ok: true, reason: `signs in this pull request with ${signaturePath(author)}` };
  return {
    ok: false,
    reason: `@${author} has not signed the contributor license agreement. Add ${signaturePath(author)} to this pull request as CONTRIBUTING.md describes (section "Before your first pull request"), with the line "${AGREEMENT}" and "GitHub: ${author}".`,
  };
}

/** Reads both signature files for a pull_request_target event and decides. `fetch` is injectable for tests. */
export async function runCheck({ event, token, fetch = globalThis.fetch }) {
  const pr = event.pull_request;
  const author = pr.user.login;
  const repository = event.repository.full_name;
  const headRepository = pr.head.repo?.full_name ?? null;
  const read = async (repo, ref) => {
    const url = `https://api.github.com/repos/${repo}/contents/${signaturePath(author).split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const response = await fetch(url, { headers: { accept: "application/vnd.github.raw+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "canon-cla-check" } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${signaturePath(author)} at ${repo}@${ref}`);
    return response.text();
  };
  const base = await read(repository, pr.base.ref);
  const head = headRepository ? await read(headRepository, pr.head.sha) : null;
  return claDecision({ author, repository, headRepository, headRef: pr.head.ref, base, head });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const result = await runCheck({ event, token: process.env.GITHUB_TOKEN });
    if (result.ok) console.log(`Contributor license agreement: ${result.reason}.`);
    else {
      console.log(`::error title=Contributor license agreement::${result.reason}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.log(`::error title=Contributor license agreement::${error.message}`);
    process.exitCode = 1;
  }
}
