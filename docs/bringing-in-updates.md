# Bringing in Canon releases (for an agent)

You are updating a fork of `fullstackgtm/canon` that may have its own changes.
`origin` is the fork and `upstream` is `fullstackgtm/canon`. If `upstream` is
missing, add it with
`git remote add upstream https://github.com/fullstackgtm/canon.git`.
Add a release to the fork without losing the owner's changes. Background and
the commands for an installation with no changes are in [updating.md](updating.md).

Nothing from a release runs until the owner says go: no checkout, `npm ci`,
build or test. A release's files can carry hooks and install scripts.

## 1. See what's coming

Run `node scripts/selfhost/releases.mjs`. It lists only releases signed with the
pinned key, and checks each against this installation's data.

- Take the release it names as safe for this data. A release marked `NOT SAFE
  YET` would break stored data; take the release it names first, finish it, and
  run this again.
- Use the commit id it prints. Never merge `upstream/main`, which can be halfway
  through something. If the listing stops showing a release, stop and say so.

## 2. Preview without checking anything out

```sh
scripts/selfhost/merge-preview.sh <commit>
git log --no-merges --no-ext-diff HEAD..<commit>   # the release
git log --no-merges --no-ext-diff <commit>..HEAD   # what must be kept
```

If the fork's copy of the script is too old or missing, read it from the release
with `git show <commit>:scripts/selfhost/merge-preview.sh` before running it.

## 3. Tell the owner and ask

In a few lines: what the release brings, which of their changes clash and how
you would settle each, any migrations listed, and any step they must take. Say
so if the release looks unfinished. Then ask. So far only git's objects changed.

## 4. Once they say go

1. `git switch -c update-<date>`, then
   `git merge --no-ff -m "Bring in release <date>" <commit>`. Never rebase or
   cherry-pick a release.
2. Settle clashes as in [updating.md](updating.md). If both sides can't be kept,
   ask which to keep.
3. Run `npm ci`, `npm run typecheck`, `npm run build` and `npm test`.
4. Report the results and ask before going on.

## 5. Install it

1. Run `npm run selfhost:backup`, then check the archive with
   `npm run selfhost:backup -- --verify <archive>`
   ([updating.md](updating.md#back-up-and-restore)). Do not skip this.
2. Fast-forward `main` to the branch and run `docker compose up -d --build`.
3. Run each listed migration, in the order printed, against this installation.
   If one fails, stop: check out the previous commit, run `docker compose build`,
   then `npm run selfhost:restore -- <archive> --replace`.
4. Run `node scripts/selfhost/verify.mjs` as after installing, and report it.
5. Only after that passes, run
   `node scripts/selfhost/releases.mjs --no-fetch --mark-data-current`. Until then
   later releases are judged against the data as it was.
