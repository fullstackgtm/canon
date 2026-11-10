/**
 * A stand-in for the two GitHub endpoints a recipe install reads (convex/lib/recipeSources.ts), for tests and local
 * live checks. Each tag of one repo is a directory of files; its commit is a hash of their contents.
 *
 *   node --experimental-strip-types scripts/recipe-github-fixture.ts --repo fullstackgtm/canon-recipes --tags <dir> --port 4790
 *
 * <dir>/<tag>/ is the repo at that tag, read again on every request, so adding a tag is adding a directory. Point
 * Convex at it with RECIPE_GITHUB_API_BASE=http://127.0.0.1:<port>/api and RECIPE_GITHUB_RAW_BASE=http://127.0.0.1:<port>/raw.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Each tag's files, by path from the repo root. */
export type Tags = Record<string, Record<string, string>>;

export const commitOf = (files: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex").slice(0, 40);

/** The fixture as a fetch handler: `/api/repos/<o>/<r>/commits/<ref>`, `/api/repos/<o>/<r>/tags`, `/raw/<o>/<r>/<sha>/<path>`. */
export function githubFixture(repo: string, tags: () => Tags): (url: string) => Response {
  return (url) => {
    const { pathname } = new URL(url);
    const all = tags();
    const commits = Object.entries(all).map(([name, files]) => ({ name, sha: commitOf(files), files }));
    const api = pathname.match(/^\/api\/repos\/([^/]+\/[^/]+)\/(commits\/(.+)|tags)$/);
    if (api && decodeURIComponent(api[1]) === repo) {
      if (api[2] === "tags") return Response.json(commits.map((c) => ({ name: c.name, commit: { sha: c.sha } })).reverse());
      const ref = decodeURIComponent(api[3]);
      const hit = commits.find((c) => c.name === ref || c.sha === ref);
      return hit ? new Response(hit.sha) : new Response("Not Found", { status: 404 });
    }
    const raw = pathname.match(/^\/raw\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/);
    const file = raw && decodeURIComponent(raw[1]) === repo ? commits.find((c) => c.sha === raw[2])?.files[decodeURIComponent(raw[3])] : undefined;
    return file === undefined ? new Response("Not Found", { status: 404 }) : new Response(file);
  };
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const repo = arg("--repo"), dir = arg("--tags"), port = Number(arg("--port") ?? 4790);
  if (!repo || !dir) throw new Error("usage: recipe-github-fixture.ts --repo <owner/repo> --tags <dir> [--port 4790]");
  const handle = githubFixture(repo, () => Object.fromEntries((existsSync(dir) ? readdirSync(dir) : []).sort().map((tag) => [tag, readTree(join(dir, tag))])));
  createServer(async (req, res) => {
    const out = handle(`http://127.0.0.1${req.url}`);
    console.log(`${req.method} ${req.url} ${out.status}`);
    res.writeHead(out.status, { "content-type": "text/plain" }).end(Buffer.from(await out.arrayBuffer()));
  }).listen(port, "127.0.0.1", () => console.log(`github fixture for ${repo} on http://127.0.0.1:${port} (tags in ${dir})`));
}
