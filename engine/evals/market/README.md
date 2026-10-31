# Market Map Eval

Agent-task benchmark for `fullstackgtm market`, modeled after the CRM Ops benchmark.

It compares two arms only:

| Arm | Tools | What it measures |
|---|---|---|
| `raw` | frozen source-page reader + file tools | Can the model create a market map without framework assistance? |
| `fsgtm` | same tools + the real `fullstackgtm market` CLI | How much does the CLI improve completeness, evidence discipline, deterministic fronts/reports, and reliability? |

The grader reads final artifacts, not the agent's self-report:

- `market.config.json`
- `observations.json` or an observation run appended by `market observe`
- `market-report.md`
- tool-call transcript, including whether the `fsgtm` arm actually used the CLI

No live web fetches are used during the benchmark. Each scenario has frozen source pages and a human/adjudicated gold map. The `fsgtm` arm gets those pages preloaded into the profile-scoped market capture store so `market worksheet`, `market observe`, `market fronts`, and `market report` work normally without nested model calls.

## Scoring

Hard gates:

- required artifacts exist and parse
- no invented/off-scenario vendors
- observations cover the generated config
- every loud/quiet quote verifies against the frozen source text
- `fsgtm` arm calls the CLI

Quality metrics:

- vendor recall/precision
- claim-concept recall/precision
- intensity macro-F1 over `loud | quiet | absent | unobservable`
- LOUD precision and false-LOUD rate
- evidence verification rate
- report/front-state presence

## Run

```bash
npm install
npm run smoke
npm test

npm run eval -- \
  --models anthropic/claude-sonnet-4-6,openrouter/moonshotai/kimi-k2.6,openrouter/z-ai/glm-5.2 \
  --arms raw,fsgtm \
  --scenarios all \
  --trials 4 \
  --out results
```

Provider prefixes:

- `anthropic/<model>` uses `ANTHROPIC_API_KEY`
- `openrouter/<vendor/model>` uses `OPENROUTER_API_KEY`
- `openai/<model>` uses `OPENAI_API_KEY`
- `compat/<model>` uses `OPENAI_COMPAT_BASE_URL` and optional `OPENAI_COMPAT_API_KEY`
- `fixture/perfect` and `fixture/sloppy` are deterministic no-key smoke fixtures

Outputs:

- `results/runs-<ts>.jsonl` — one row per scenario × model × arm × trial
- `results/report-<ts>.md` — leaderboard, cost estimates, and violation details
- `results/transcripts-<ts>/...json` — tool transcripts for audit/debugging
- `results/artifacts-<ts>/.../` — preserved final artifacts (`market.config.json`, observations, report) per run

## Current v0 scenarios

- `creative-intelligence-mini` — creative intelligence/analytics SaaS with a failed capture vendor.
- `ai-sales-research-mini` — enrichment, signal intelligence, sequencing, and workflow automation.
- `cloud-security-posture-mini` — CNAPP/posture, attack paths, runtime detection, compliance automation.
- `customer-support-ai-mini` — AI support agents, copilot, omnichannel inbox, public pricing.
- `data-activation-mini` — reverse ETL, audience builders, identity resolution, managed ELT.
- `conversation-intelligence-mini` — call recording/transcription, deal risk, coaching, clips/highlights.

Add scenarios in `src/fixtures/scenarios.ts`: frozen pages, vendor IDs/URLs, gold claim concepts, and gold vendor × claim cells.
