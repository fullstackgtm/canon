# Canon module kit

`@fullstackgtm/canon-module-kit` is the contract a [Canon](https://github.com/fullstackgtm/canon) module is built
against: the types its server code uses, and a command that checks and builds the module. A module needs nothing else
from Canon. [Build a module from your own repository](https://github.com/fullstackgtm/canon/blob/main/docs/modules.md#build-a-module-from-your-own-repository)
walks through a whole module.

## Commands

Each command takes module directories, the current one when you give none. A module directory holds `module.json`
and, for a module with calls, `server.ts`.

```sh
npx canon-module-kit check <dir>
npx canon-module-kit build <dir>
```

- `check` reads `module.json` whole and lists every problem with its path, as
  `pages[0].body[1].from names count, whose call count declares no result to draw`. It then reads every source file in
  the directory and fails on an import that leaves it. A module imports only its own files, this kit and npm packages.
- `build` checks `module.json`, bundles `server.ts` into the file `module.json`'s `server` names, and checks that the
  bundle exports a function for every call `module.json` declares. It prints the bundle's path, size and hash. Commit
  the bundle. Canon installs the committed file.

Each command exits with 0 when every module passes, 1 when one fails, and 2 when the command name is unknown.

## Types

`server.ts` imports the contract's types by file:

```ts
import type { CallFunctions, ReadDoc } from "@fullstackgtm/canon-module-kit/calls";
```

The main entry, `@fullstackgtm/canon-module-kit`, exports `calls`, `facts` and `proposals` together. Every other file
of Canon's `modules/kernel/` directory is a subpath of the same name, as `@fullstackgtm/canon-module-kit/manifest`.
Import types with `import type`: the build drops them, so the bundle holds no code of the kit's. A value import, such as
`migration` from `calls`, is copied into the bundle.

## Tests

A call is a plain function of a context and the reads its plan names. Test it by calling it with both and checking what
it returns. Canon's [`tests/staleFactsExample.test.ts`](https://github.com/fullstackgtm/canon/blob/main/tests/staleFactsExample.test.ts)
tests the Stale facts example this way.

## Versions

The kit's major version is the module API it builds for, `engines.moduleApi` in `module.json`. Kit 1.x builds modules
for module API 1.

## License

The kit is licensed under AGPL-3.0-only (`LICENSE`). Two of its files, `evidence.js` and `websiteSources.js`, are
copies of Canon's engine and keep the engine's Apache-2.0 license (`LICENSE-APACHE`).
