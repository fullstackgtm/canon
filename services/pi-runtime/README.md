# Pi runtime local proof

This service pins Pi Durable 1.3.0 and uses its Cloudflare SQLite adapter.
`wrangler.jsonc` defines the candidate production Worker. The comparison uses
`src/prototype-worker.ts`, which adds a demo-only Convex lease host and the
upstream storage conformance suite. Neither entrypoint is deployed.

Run commands from the repository root through shared admission. The local
installed Node 22.17.1 can launch Wrangler, but it is below Pi's declared
Node-adapter floor of 22.19. Do not treat Node-adapter results on that version
as supported-runtime proof. Both comparison hosts execute inside workerd.
Set `CANON_NODE22_BIN` to your existing Node 22 executable directory.

```sh
PATH="${CANON_NODE22_BIN:?}:$PATH" npm run test:target -- tests/piRuntime.test.ts tests/piRuntimeTokens.test.ts tests/piRuntimeCrash.test.ts
PI_RUNTIME_COMPARE=do PATH="${CANON_NODE22_BIN:?}:$PATH" npm run test:target -- tests/piRuntimeComparison.test.ts
```

The first command skips Node-adapter cases below the declared floor. The
second launches a local Wrangler process, kills it after committed progress,
and reopens its persisted SQLite storage. It repeats five times and verifies
actual fake-model responses, including the nonce of the process that first
produced each response. A viewer connects to the DO by WebSocket using a
signed, expiring watch ticket. No vendor call is allowed in probe mode.

The paired comparison starts this worktree's managed stack only after check
admission, reads its generated ports and stops it on completion or failure.
Its normal idle shutdown remains enabled. Run:

```sh
PI_RUNTIME_COMPARE=1 PATH="${CANON_NODE22_BIN:?}:$PATH" npm run test:target -- tests/piRuntimeComparison.test.ts
```

The Convex host reads this worktree's existing anonymous local admin credential
privately and refuses a port mismatch. Its Worker bridge accepts only a
127.0.0.1 backend, and its internal mutation refuses non-demo deployments.
It creates no credential and never prints one. The fixture signing key has
no external authority. Test Workers and their process groups are terminated
on completion or interruption.

Results are written to `.devstack/pi-runtime/comparison-do.json` or
`comparison.json`. Restart readiness includes Wrangler startup. Resume time
runs from process termination until the client observes a newly committed
step, including the remaining synthetic model delay and polling. `checkpointMs`
measures the primary checkpoint commit, excluding the separate measurement
commit and model call. `observedStepOverheadMs` subtracts the 1,500 ms synthetic
model delay from consecutive client-observed steps, excluding the interval
that crosses the crash. It includes model response processing, memo writes,
both checkpoint commits and client observation noise. The polling sleep is
25 ms; HTTP time and host contention add to it. Negative
samples are retained as timing noise. The paired run also executes upstream's
storage conformance cases against the lease adapter. Artifacts retain completed
samples and a failure phase when a later trial fails.
These are local prototype timings, not production cost or latency
estimates. No result is verified merely because this command exists.

The Worker admits one immutable run input per object. A read before admission
returns 404. A repeated start with different input returns 409. The manual account text migration uses signed Canon callbacks, bounded record
tasks and atomic Canon landing. Enablement remains off. The real fixture uses
the existing local admin bridge, so deployed HMAC transport and real credentials
remain unverified. The owned-stack alarm recovery proof runs with `PI_RESEARCH_PROOF=1`
under the existing Node22 PATH.
The empty `CANON_CONVEX_SITE` in the candidate configuration fails closed.
Human configuration, deployment and Doppler-bound secret upload are gates.
