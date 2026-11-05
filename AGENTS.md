# Agent instructions — Cinema Loyalty Service

## Scope and baseline

- Work only in this repository unless the task explicitly authorizes changes elsewhere. Do not modify `cinema-platform-back` as a side effect.
- Start by checking the active branch, `git status`, and relevant code. Preserve uncommitted user changes. The checked-in branch may not contain the latest local code.
- Stack: NestJS 11, TypeScript, PostgreSQL + Prisma 7, Redis + BullMQ, RabbitMQ, gRPC, Jest. Bun 1.3.13 is the package manager; production executes compiled code on Node.js 22. Preserve `bun.lock` and existing runtime choices unless the task requires changes.
- Keep changes small and localized; avoid speculative refactors, packages, migrations, or rewrites.

## Architecture and invariants

- Keep transport validation/adapters in controllers/consumers, orchestration/business rules in services, and persistence in Prisma-backed operations.
- Preserve idempotency of ticket purchases, refunds, deductions, birthday grants, achievement processing and admin adjustments. Do not silently change existing event or gRPC contracts.
- Money/points/visits/tier decisions must use a consistent transaction snapshot and existing profile-lock discipline; see `docs/profile-concurrency.md`.
- Write business state, ledger entries, deduplication rows, and related outbox/intent records atomically when they represent one business operation.
- Never call Redis, RabbitMQ, or external RPCs inside retried PostgreSQL transaction callbacks.
- Assume at-least-once message delivery; retries and timeouts can cause duplicates. Require persistent consumer-side idempotency; a Redis job ID alone is insufficient.
- For background dispatch, assess atomic claim/lease ownership, expired lease recovery, fencing, retry bounds, poison messages, and observability.
- Prefer explicit dependency injection, runtime validation of untrusted payloads, controlled concurrency, and typed error handling.
- Do not log credentials, access tokens, raw secrets, or sensitive customer payloads.

## Read documentation only when relevant

- Architecture/business behavior: `README.md`.
- Profile writer concurrency/locking: `docs/profile-concurrency.md`.
- Distributed event delivery, outbox and retries: `docs/reliability.md`.
- Production audit and quality gates: `docs/production-readiness.md`.
- Deployment work: `docs/runbooks/deployment.md`.
- For NestJS code review use `$nestjs-code-review` when a review is explicitly requested.
- For queue, outbox, retry or concurrency changes use `$distributed-reliability`.
- For a deployment-readiness assessment use `$production-audit`.

## Verification

- Install: `bun install --frozen-lockfile` (only when needed).
- Prisma codegen: `bun x prisma generate` (when schema/client changed).
- Lint: `bun run lint`; build: `bun run build`; tests: `bun run test --runInBand`.
- PostgreSQL integration: `bun run test:integration` (requires Docker); proto checks: `bun run buf:lint` and `bun run buf:build` when contracts change.
- Add regression tests for changed behavior. Locking, concurrency and transaction guarantees must be verified against real PostgreSQL, not only mocks.
- Never weaken tests merely to make CI green. Report which checks were run and which were not.
- For the installed Prisma 7 workflow, `bun x prisma migrate deploy` is for deployment; do not run dev/reset against production. Review schema changes and migrations before applying.

## Working style

- For changes affecting persisted data, wire contracts, or distributed guarantees, state the invariant, concrete failure scenario, minimal proposed fix, and tests before editing.
- Distinguish confirmed defects from hypothetical risks. Highlight trade-offs and production limitations; do not claim exactly-once delivery.
- No automatic commit, push, production deployment, secret changes, or destructive database operations unless the user specifically requests them.
- Final response in Ukrainian: what changed, why, risks, test evidence, remaining work.

## Pull request descriptions

- Write for a reviewer who has not seen the conversation. Lead with the concrete problem and resulting behavior.
- Use a Conventional Commit-style title and concise sections: problem/result, changes, verification, and relevant limitations or rollout requirements. Omit sections that add no useful information.
- Explain important invariants and compatibility consequences in plain language. Include actual test commands/results and distinguish local checks from CI on the current HEAD.
- Describe the final patch, not the sequence of agent actions, previous drafts, or repeated audit reports. Keep detailed execution logs in chat or linked CI runs.
- Use normal sentence case; avoid all-caps status paragraphs, excessive emphasis, unexplained abbreviations, and long lists of unrelated exclusions. Keep necessary identifiers such as GOLD unchanged.
- Preserve real Markdown newlines and blank lines around headings/lists. With PowerShell, decode `gh --json body` as JSON to obtain one string; do not implicitly cast multiline CLI output arrays to a string. Submit descriptions using `--body-file` and read them back from GitHub to verify formatting.
- Keep the description current after changes. Report pending or skipped checks honestly; never claim a fresh review or successful CI from an earlier commit.
