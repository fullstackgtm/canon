# Bombadil UI exploration (manual)

[Bombadil](https://github.com/antithesishq/bombadil) (MIT, Antithesis) clicks, types, scrolls
and reloads through the running app at random. It checks temporal properties on every state it
captures. This directory holds a CanonCRM specification and a runner. It is not part of PR CI.

```sh
npm run dev:isolated -- --background        # this worktree's stack
npm run e2e:bombadil                        # 10 minutes, headless, from /dashboard
npm run e2e:bombadil -- --time-limit 3m     # extra flags go to `bombadil browser test`
npm run e2e:bombadil -- inspect .bombadil/run
npm run e2e:bombadil -- --reproduce .bombadil/run
npm run e2e:bombadil -- shrink --trace .bombadil/run --property noUncaughtExceptions --time-limit 30m
npm run dev:stop
```

`run.mjs` reads the app port from `.devstack/ports.env` and has no URL override. It passes
`--allow-url` for that port on `localhost` and `127.0.0.1`, so exploration cannot leave the
machine. The `staysOnLocalhost` property checks that this held. The runner fetches the pinned
`@antithesishq/bombadil@0.8.0` with `npx`, which keeps the 48 MB binary out of `package-lock.json`
and out of CI installs. It drives the installed Google Chrome. Traces go to `.bombadil/`, which
git ignores.

## Properties (`canon.ts`)

| Property | Checks |
| --- | --- |
| `noUncaughtExceptions`, `noUnhandledPromiseRejections`, `noConsoleErrors`, `noHttpErrorCodes` | Bombadil's defaults |
| `noErrorScreens` | No `dashboard/error.tsx` boundary, 404 page, Next.js error dialog or "N Issues" badge |
| `staysOnLocalhost` | Every URL is `localhost` or `127.0.0.1` |
| `archivedStayArchived` | A record archived by the `archiveOne` action leaves the Accounts or People list within 5 s and never comes back |
| `listCountsConsistent` | "Showing X of Y" and "N shown · M loaded of T" agree with the rendered rows within 5 s |
| `typedTextKept` | Text typed into a focused field is in that field in the next state |

The actions are the default clicks, minus Next.js dev tools, Undo, Restore and sign-out. On top of
those come inputs, scroll, back, reload, a `goToList` jump to the record lists, and `archiveOne`,
which archives a random visible account or person and records its name in `localStorage`.

## Writing properties: gotchas

- Properties and action filters run in Bombadil's own JavaScript runtime, not the page. It has no
  `URL` global, and an exception there reads as a violation of the property. Extractors run in the
  page and have the full DOM API.
- `next dev` is slow on first compile, and Bombadil acts every 50–100 ms. Give properties about
  settled UI an `eventually(...).within(5, "seconds")`.
- After the first error, the dev overlay's "N Issues" badge stays up, so `noErrorScreens`
  reports again on every later state. Read the first report.
- `shrink` replays the whole trace three times to calibrate before it shrinks. For a trace with
  hundreds of actions, give it `--time-limit` of 30 minutes or more.
