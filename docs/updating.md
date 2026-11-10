# Updating Canon

This is for you or your agent, when updating a Canon installation to a newer
release. Installing is in [self-hosting.md](self-hosting.md).

## Releases

A release is a tag named `release/<date>` on the public repository, signed with
the publisher's SSH key. The tag message lists what changed. Only update to
signed releases, never to the tip of `main`, which can be halfway through
something.

`npm run selfhost:releases` fetches the release tags into
`refs/canon/releases/`, checks each signature and lists the verified releases
your checkout doesn't have yet, with their notes. It needs only git and Node:
run `node scripts/selfhost/releases.mjs` before `npm ci` has been run. It reads
from the `upstream` remote if there is one, otherwise `origin`. Pass
`--remote <name>` to choose, `--no-fetch` to skip fetching, and `--json` for
the full result.

The first run copies the key in `scripts/selfhost/release-signers` to
`.canon/release-signers`, which git ignores. After that the copy decides. If a
later checkout changes the key in the repository, the script says so and keeps
using the copy. Replace the copy only after confirming the new key with the
publisher. Tags without a valid signature from the pinned key are counted and
ignored.

## Update an installation without changes of your own

1. Run `npm run selfhost:releases` and read the notes of each release you are
   about to take. Stop and ask if a release looks unfinished or mentions a step
   for you to take.
2. Back up the data volume while Canon is stopped
   ([self-hosting.md](self-hosting.md), "Preserve data and upgrade").
3. Check out the release: `git merge --ff-only refs/canon/releases/<date>`.
4. Rebuild and start: `docker compose up -d --build`. On start, the container
   pushes the new backend functions before it starts the web app.
5. Run the verifier again with the existing owner, as after installing, and
   report its output.
6. Run any migrations the release listed, then record that the data is current:
   `node scripts/selfhost/releases.mjs --no-fetch --mark-data-current`.

If a step fails, restore the volume from the backup, check out the previous
commit and rebuild.

## Update a fork with changes of your own

Agents should follow [bringing-in-updates.md](bringing-in-updates.md), which previews
the merge before running anything from the release.

If your `main` has commits of its own, merge the release instead of
fast-forwarding. Do it on a branch, so the installation keeps running the
current code until the merge is checked.

1. See what's coming: `git log --no-merges main..refs/canon/releases/<date>`.
   See what must be kept: `git log --no-merges refs/canon/releases/<date>..main`.
2. Merge: `git switch -c update-<date>`, then
   `git merge --no-ff -m "Bring in release <date>" refs/canon/releases/<date>`.
   Always merge. Never rebase or cherry-pick a release. Its commits must keep
   their ids, or later releases won't recognize this checkout as up to date.
3. Resolve conflicts by what each side meant, from both sides' commit messages:
   - If the release now does what your change did, keep the release's version
     and say so.
   - If the release moved or rewrote code you changed, apply your change to the
     new code.
   - If both can't be kept, stop and ask which one to keep, and what each does.
4. Check the merge with `npm ci`, `npm run typecheck`, `npm run build` and
   `npm test`.
5. Report what the release brings, which of your changes were reworked or
   dropped and why, and the check results. Ask before going on.
6. When approved, fast-forward `main` to the branch, then follow steps 2, 4 and 5
   of the section above.

To take a release back out, run `git revert -m 1 <merge commit>` and rebuild.
Restore the volume backup too if the release changed stored data.

## Keep changes small and easy to merge

Every edit to Canon's own files can conflict with a later release. Use the
lightest option that does the job:

1. Settings and the `.env` file.
2. Modules and recipes ([modules.md](modules.md), [recipes.md](recipes.md)).
   They live outside Canon's own code, so releases don't touch them.
3. Edits to Canon itself, committed to your `main` and merged with each release.
