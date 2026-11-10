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
2. Take a backup and check it, as in [Back up and restore](#back-up-and-restore).
   Take one before every update.
3. Check out the release: `git merge --ff-only refs/canon/releases/<date>`.
4. Start the new release. On start, the container pushes the new backend
   functions before it starts the web app.
   - If `.env` names a published image (`CANON_IMAGE`, which
     `scripts/selfhost/install.sh` writes), set it to the release's image,
     `ghcr.io/fullstackgtm/canon:<date>`, then run
     `docker compose pull && docker compose up -d`. The image's
     `org.opencontainers.image.revision` label must be the release's commit:
     `docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/fullstackgtm/canon:<date>`.
   - Otherwise rebuild from the checkout: `docker compose up -d --build`.
5. Run the verifier again with the existing owner, as after installing, and
   report its output.
6. Once the container is healthy, it runs any migrations the release listed, in
   order, and then records the volume's new data epoch. Its log says which
   migration failed, if one did; restarting the container runs them again.
   After they ran, record that the checkout's data is current:
   `node scripts/selfhost/releases.mjs --no-fetch --mark-data-current`.

If a step fails, check out the previous commit, set `CANON_IMAGE` back or run
`docker compose build`, and restore the backup with `npm run selfhost:restore -- <archive> --replace`.

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
Restore the backup too if the release changed stored data.

## Back up and restore

`npm run selfhost:backup` stops Canon, writes the whole `data` volume to one
archive, then starts Canon again and waits until it is healthy. The Convex
database and the record service's DuckDB files refer to each other. Only a
stopped container closes both at the same moment, so the backup always stops
it. Expect under a minute of downtime: the archive takes a few seconds on a
small install, and most of the time is Canon starting again.

Run the commands from the Compose checkout on the Docker host. They need only
Node, git and Docker, so `node scripts/selfhost/backup.mjs` works before
`npm ci` has been run.

```sh
npm run selfhost:backup
npm run selfhost:backup -- --verify ../canon-backups/canon-backup-<time>.tar.gz
```

The archive goes to `../canon-backups/`, next to the checkout. To choose another
directory, pass `--out <dir>`. The directory must be outside the checkout,
because `docker compose build` copies the checkout into the image. A helper
container mounts it, so on Docker Desktop it must be in a shared location, such
as your home directory.

`--verify` reads the whole archive and checks every file against the manifest.
It also says whether this checkout can restore the archive. It changes nothing.
After it passes, copy the archive to another machine.

To prove a backup restores, run the verifier with `--backup-restore` from the
checkout. It takes a backup, restores it over the running install, and reads
back the owner, company, person and deal it created:

```sh
node --env-file=../canon-owner.env scripts/selfhost/verify.mjs http://localhost:3000 --backup-restore
```

### What the archive holds

The archive is a `.tar.gz` that ends with `manifest.json`. The manifest records
the format version, when the backup was taken, the checkout's commit, the image
id, the data epoch, the record service's contract version, and the size and
SHA-256 of every file. The volume's files are under `data/`:

- `data/convex/`: the Convex SQLite database, uploaded files and the deployed
  functions. Its scratch directory, `tmp`, is restored empty.
- `data/records/`: one DuckDB file per workspace.
- `data/credentials/`: the backend's instance secret and admin key, the record
  service token, the token encryption key and the key that signs sessions.

The archive holds every credential the install generated. Anyone with a copy
can read the CRM's data and decrypt the integration tokens it stores. Keep
every copy as private as the server. A restore needs these credentials:
without the token encryption key, the stored integration tokens can't be
decrypted, and without the signing key, every session ends.

The archive does not hold:

- The checkout and your changes to it.
- Settings outside the volume: `SITE_URL`, `CANON_AUTH`, Clerk keys, and the
  integration keys in your environment or `.env` file. Keep a copy with the
  archive.
- `.canon/release-signers`, the release key you pinned. Copy `.canon/` to a
  new machine to keep it. The data epoch is in the manifest, and a restore
  writes it to `.canon/data-epoch`.
- Your reverse proxy and TLS setup.

### Restore a backup

1. Check out the commit the backup came from, or a later release, and run
   `docker compose build`.
2. Set `SITE_URL` and the other settings the backed-up install used.
3. Run `npm run selfhost:restore -- <archive>`. To restore over an existing
   install, add `--replace`.
4. Run `node scripts/selfhost/verify.mjs` with the owner's credentials.
5. If the restore listed migrations, run them in order, then run
   `node scripts/selfhost/releases.mjs --no-fetch --mark-data-current`.

Before it changes anything, restore checks every file against the manifest. It
also checks the data epoch, and refuses data newer than the checkout supports or
older than the oldest data it can read. If the volume already holds an install,
restore stops unless you pass `--replace`. With `--replace`, it moves the
current contents to `.restore-previous` in the volume before it restores. If
the restored install becomes healthy, restore deletes `.restore-previous`. If
it doesn't, restore puts the previous contents back and starts them again. If a
restore is interrupted, `.restore-previous` stays, and the next restore stops
until you inspect it.

## Keep changes small and easy to merge

Every edit to Canon's own files can conflict with a later release. Use the
lightest option that does the job:

1. Settings and the `.env` file.
2. Modules and recipes ([modules.md](modules.md), [recipes.md](recipes.md)).
   They live outside Canon's own code, so releases don't touch them.
3. Edits to Canon itself, committed to your `main` and merged with each release.
