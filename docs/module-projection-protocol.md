# Module projection receipts

This is the W3b prerequisite for the existing whole-doc `module_docs` projection.
The first rollout stage adds only the additive record-service wire protocol and derived-store receipts. Existing backend callers continue using unversioned traffic. Backend initialization and adoption are preserved for a following PR after service 1.43.0 has an actual dev deployment receipt.

It does not add Activities report sources, activity projection roots, scope OR,
search or watch integration. Source module documents and their writers remain
authoritative. Existing report scope compilation is unchanged.

## Identity and ordering

Contract 1.43.0 adds an optional projection stamp and work identity to module
syncs. The stamp contains the retained Convex package ID, serving epoch, rebuild
generation and complete sorted collection closure from `projectedCollections`.
That closure currently contains report roots and their parent/where dependencies.
It has an explicit limit of 100 collections; exceeding it refuses initialization.

Ordinary uninstall retains the package row. Reinstall advances its epoch. Enable
and each newly serving version advance the derived rebuild generation. An unknown
package ID cannot replace a service stamp, even with a higher epoch. Hard deletion
of package metadata therefore needs explicit derived-store recovery; normal
uninstall/reinstall does not. No source per-document revision store or global
counter is introduced.

Incremental work carries each leased job row ID and `dirtySeq`. Clock seeding is
not assumed unique after a completed job is deleted. The service keeps per-key
receipts, including tombstones, and a collection sequence floor. A collision
returns that floor; the source advances the same still-current dirty job above
it, releases the lease and reads the source again. Completion requires package,
generation, job row identity and leased sequence to remain current.

The first accepted delivery of a leased identity wins; its duplicate is a no-op.
Source changes during that lease dirty its key at a higher sequence. This is an
ordering protocol for derived data, not source-document CAS or an alternate
write path.

## Rebuild and readiness contract

All pages of a rebuild carry one initial rebuild sequence and job identity,
even though continuation leases have newer dirty sequences. A final versioned
acknowledgement closes the collection. Its sweep removes unseen rows only at or
below that rebuild sequence. Newer incremental rows survive. Closed collection
floors reject older unseen keys; delayed pages and duplicate finals cannot reopen
the completed rebuild. Order receipts are retained after row deletion and can be
discarded only when a newer accepted module stamp fences the whole old generation.

Missing initialization is never ready. The backend adoption stage initializes idempotently through module report actions, the job lease path and the existing sweep.
Each required collection must finish its acknowledged rebuild. Any dirty key,
including waiting or exhausted failed work, withholds projected report counts.
A failed rebuild also holds incremental delivery behind it. Existing lease scan,
page (200 docs), read (25 docs), sync (500 docs / 4 MB), and sweep scheduling bounds
remain; they may delay convergence, but never make partial initialization ready.
Expired or superseded work waits for its existing lease to be released or expire.

The following backend adoption stage makes ordinary module reports and team aggregates require the current source
readiness state before and after the service read. The service verifies the full
closure in the same database snapshot as the aggregate and echoes the stamp.
The HTTP client refuses a missing or different echo. Counts are exact over that
projected snapshot; this does not make the two databases a single transaction.
The adoption stage clears UI counts on errors and retries projection syncing/unavailable errors.
The fake report path still reads source documents directly and does not claim a
service projection exists. The fake advertises contract 1.42.0 and refuses stamped sync work. It cannot return a 1.43.0 receipt without implementing the derived store and its ordering checks. A fake runner therefore leaves projection jobs failed and incomplete; its reports continue to read authoritative source documents. Managed local stacks run the actual record service.

## Transition

This widens the wire/schema contract. Unversioned traffic continues to work on
untouched legacy projections. The first fenced rebuild claims a module projection
and rebuilds its derived rows; thereafter unversioned writes and reads are refused.
Source jobs finish only after a matching accepted receipt. An older service that
rejects or ignores the added metadata cannot complete those jobs or provide a
fenced aggregate answer. Failed initialization remains visible as unavailable.
Service 1.43.0 must be confirmed deployed before the backend adoption PR merges. CI deploys the record service and Convex in parallel, so these are separate checked PRs. Once adopted, workspace
files must continue to be served by a binary that enforces these receipts; rolling
back to an unaware service binary is not supported. The existing bounded
failure/backoff policy remains: exhausted work stays unavailable until that key
is dirtied again or a report reader explicitly selects Retry sync. That bounded retry resets stopped report jobs, including rebuilds, and wakes the runner; it neither completes a receipt nor changes source documents. A newly serving version also retries stopped report jobs. A rebuild does not silently discard exhausted incremental keys.

No source tables are dropped. This protocol does not change module package versions or workflows.
