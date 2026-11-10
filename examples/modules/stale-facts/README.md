# Stale facts

An example module built the way a module outside Canon is built. It uses only the module contract
([docs/modules.md](../../../docs/modules.md)) and type imports from the module kit, `@fullstackgtm/canon-module-kit`.

For the deals closing from 30 days ago to 90 days out, and the companies the member sees, 50 at a time from
`companies.updatedSince` (the ones changed longest ago first), it reads Canon's fact ledger with `facts.forRecords`.
The company page's ids go straight into `facts.forRecords`, and **Next 50 companies** reads the following page with
the `next` the last row carries. It lists the contested fields first, then the ones confirmed longest ago. A member
proposes a corrected value with evidence through `facts.propose`. A member who reviews facts accepts or rejects it on
the fact review queue, and the page shows each proposal's outcome from `proposals.byIds`.

## Build

In a copy of this directory in its own repository, with the module kit installed (docs/modules.md, "Install the kit"):

```sh
npx canon-module-kit check
npx canon-module-kit build
```

From a Canon checkout:

```sh
npm run module:build -- examples/modules/stale-facts
```

Each checks `module.json` and writes `dist/module.js`. Commit both. `server.ts` imports only types from the kit, so
the bundle needs nothing from Canon at run time, and both builds write the same bytes. Inside Canon, a `paths` entry in
`tsconfig.json` points the kit's package name at `modules/kernel/`. `server.ts` imports `module.json`, so the attributes
it may propose come from the manifest's `facts` and aren't written twice.

## Install

On Customization, choose **Browse**, then **From GitHub**, and give the directory at a tag:
`github:<owner>/<repo>/examples/modules/stale-facts@<tag>`. Installed modules start off. Turn it on there.

On a local stack, serve the directory as a GitHub fixture and install from it (docs/modules.md, "Install and enable").
The tag directory holds the repository at that tag:

```sh
mkdir -p /tmp/tags/v0.3.0/examples/modules
cp -r examples/modules/stale-facts /tmp/tags/v0.3.0/examples/modules/
node --experimental-strip-types scripts/recipe-github-fixture.ts --repo <owner>/<repo> --tags /tmp/tags --port 4829
convex run modules:installFromLocalBase '{"base": "http://127.0.0.1:4829", "source": "github:<owner>/<repo>/examples/modules/stale-facts@v0.3.0"}'
convex run modules:setEnabled '{"moduleId": "@examples/stale-facts", "enabled": true}'
```

## Records the ledger doesn't hold yet

A company that hasn't synced from a CRM or been edited has no facts yet. `facts.forRecords` returns its fields as
`empty`, so the page lists them and a member can propose a value. The proposal puts the company on the ledger first, as
`canonEntities.promote` does, when the member may edit companies. A company the member can't see has no row and isn't
listed.
