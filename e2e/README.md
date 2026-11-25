# Local CRM smoke

Run `npm run dev:setup`, `npx playwright install chromium`, then
`npm run dev:isolated -- --background` and `npm run e2e:smoke`.
Stop the stack with `npm run dev:stop` afterwards.

The single Chromium test reads this worktree's port from `.devstack/ports.env`.
Use the default demo auth mode and seeded workspace. It follows `/sign-in` to
the dashboard, loads Companies, People and Deals with actual record rows, and
opens a company record. Browser console errors and uncaught exceptions fail it.
There are no external services or fake Salesforce fixtures in this suite.

CI wiring is deferred. A runner needs the anonymous local Convex backend,
record service, Wrangler runtime and Playwright Chromium with OS dependencies,
plus stack lifecycle cleanup even on failure. Measure cold startup and memory
on jog before adding that work to PR admission. This local run uses the full
isolated stack; it does not prove real Clerk authentication or OAuth callbacks.
