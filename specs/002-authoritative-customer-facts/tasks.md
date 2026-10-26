# Tasks: Authoritative customer facts

**Input**: [spec.md](spec.md), [plan.md](plan.md), [constitution](../../.specify/memory/constitution.md), [master](../../docs/loyalty-economy-architecture-spec.md).
**Status**: Planning only; every implementation task is intentionally unchecked. No branch/commit/migration/application change authorized.
**Paths**: L/ = loyalty worktree; B/ = backend worktree. Both read this single central SDD change. Data model, wire contract, research and verification are sections of plan.md, not extra prerequisite documents.

## Phase 1 — Baseline and shared contract

- [ ] T001 Re-fetch/revalidate B origin/main including PR #80 and L origin/master, inspect both AGENTS.md/status, record exact pair and unrelated files. Only after implementation authorization create dedicated worktrees for the authorized PR half; preserve current backend branch. Follow plan.md cross-repository handoff. (FR-010/011; all stories)
- [ ] T002 Finalize the exact `CUSTOMER_FACTS_CHANGED` schemaVersion 1 fixtures in L `test/fixtures/customer-facts.ts` and matching B `tests/Cinema.OrdersTests/CustomerFactsTests.cs`: field/null/kind rules, UUID/Int revisions, UTC millisecond precision, date-only DOB, semantic equality. Include registration-null legacy root, future clock skew, Kyiv midnight/DST/leap-day/as-of-cutoff fixtures without implementing new economy calculators. Cross-review both PR halves against plan.md; no independent conflicting contract definition. (FR-003/009/011/012; US1/US2/US3)

**Checkpoint**: Proposed wire names/types and facts-only activation boundary approved for implementation. No producer emission before consumer compatibility.

## Phase 2 — US3: PR A, passive loyalty receipt/projection

**Goal**: Ship an independently testable reader before backend emits the pattern. **Independent test**: feed exact fixtures over real RMQ/PG, observe durable ordered facts and zero financial writes.

- [ ] T003 [US3] Add failing unit/DTO tests in L `src/loyalty/customer-facts.service.spec.ts` and consumer specs for invalid kind/date/revision/version, canonical equality, current legacy operation isolation and safe logs. Add PG tests first in `test/integration/customer-facts.integration-spec.ts` for duplicate/conflicting user/revision/event identities, reordered 3→1→2, null-root evidence and atomic receipt/projection rollback. (FR-003/005/007/008/009/011/012)
- [ ] T004 [US3] Add proposed CustomerFactsProjection/CustomerFactReceipt models to L `prisma/schema.prisma` and an additive migration, with eventId/user-revision uniqueness, positive revision/state constraints and nullable unknown timestamps. Keep accounting schema untouched. Add clean/previous-schema migration checks in existing disposable integration setup. Do not apply outside a verified disposable DB. (FR-003/005/008/011)
- [ ] T005 [US3] Implement thin L `src/loyalty/consumers/customer-facts-changed.consumer.ts`, DTO, enum/module wiring and `customer-facts.service.ts`: validated receipt→contiguous projection under withTransactionRetry and profile lock. Check both identities, compare canonical contents, preserve immutable source fields and predecessor semantics; pending contradictions become durably BLOCKED. A cross-user eventId uniqueness race must become a verified identity conflict after rollback/fresh read, not a swallowed P2002. (FR-005/007/008/009/012)
- [ ] T006 [US3] Add PG restart/concurrency tests before recovery implementation: receipt committed then crash before apply, >50 ready revisions, event/job/two replicas with controlled profile-lock overlap, missing predecessor/non-hot-loop and blocked predecessor. Implement bounded recovery in the same L provider using existing Nest Schedule; verify actual pending-next SQL/EXPLAIN and add only justified indexes. (FR-005/008/013)
- [ ] T007 [US3] Extend L `src/loyalty/consumers/rmq-delivery.service.ts` Operation and `message-failure.ts` codes for new facts; preserve existing budget/backoff/quarantine and completed-DOB-cycle rule. Add logger capture with dummy DOB/private extras. New receipt/projection path must not call accounting, grants, achievements or tier writers. (FR-006/010/012/013)
- [ ] T008 [US3] Add/run real RMQ regressions in L `test/rmq/customer-facts.transport-spec.ts`, reusing `test/fixtures/rmq-delivery-worker.cjs` only as necessary: valid/permanent/transient/duplicate/out-of-order, restart with persistent budget, durable pending receipt and controlled replay. Add minimal test-only post-commit/pre-ACK barrier; close actual connection and require broker redelivered=true/original body, not manual republish. Explicitly BLOCK any unverified lost-ACK case. (FR-005/006/007/008/012/013)
- [ ] T009 [US3] Verify PR A locally before any commit: L unit/integration/RMQ/build/lint and migration tests, unchanged legacy DOB bonus/dedupe and all financial invariants. Update only existing reliability/setup documentation with pattern, unknown/gap/blocked semantics and replay controls. Record commands/exits/skips and clean own disposable resources. (FR-005/006/010/011/012/013; SC-003/004/005/006)

**Checkpoint A**: Reader is passive, durable and recoverable. PR A may be committed/published only under separate authorization. Its actual committed SHA becomes B's reader dependency; this checklist does not authorize Git operations.

## Phase 3 — US1: PR B, authoritative registration and first DOB

**Goal**: Facts originate in actual accepted Identity mutations. **Independent test**: real scoped UserManager/EF Bus Outbox transactions, fresh-scope reconstruction and concurrent first-set routes.

- [ ] T010 [US1] Add failing B unit/PG regressions in `tests/Cinema.OrdersTests/CustomerFactsTests.cs` and `CustomerFactsPostgresTests.cs` using existing outbox/Identity/PG fixtures: registration time and role atomicity, both first-DOB routes, set-once repeat, concurrent overlapping routes, immutable source facts, null historical accounts, and exact DB/wire millisecond/date round-trip. Use EnableRetryOnFailure as production does. (FR-001/002/003/005/009/011)
- [ ] T011 [US1] Add narrow User fact mutations/properties, CustomerFactRevision audit entity/configuration, DbSets and additive EF migration/designer/snapshot in B paths listed in plan.md. Keep nullable existing timestamps without database now/backfill. Add migration regressions in `tests/Cinema.DbUpdaterTests/DbUpdaterCliTests.cs` for empty/previous-schema PG. (FR-001/002/003/009/011)
- [ ] T012 [US1] Implement registration transaction in B `src/Cinema.Infrastructure/Services/IdentityService.cs` and concrete shared CustomerFactsWriter/interface as justified: same scoped Identity/context/outbox, check CreateAsync and role result, one captured instant/revision, no automatic retry of tracked state. Add source journal/envelope reconstruction and internal restaging from immutable stored facts. (FR-001/003/005/006)
- [ ] T013 [US1] Route B SetMyDateOfBirth and UpdateProfile through the same protected first-set operation: source row lock→reload→check→timestamp/revision→outbox→commit. Keep names-only/no-change behavior, ConcurrencyStamp and current self-service responses. Stage facts-only and existing initial-DOB/profile messages atomically; no correction/registration financial legacy message. Update B existing DOB envelope identity/time from persisted fact. (FR-002/003/005/006/010)
- [ ] T014 [US1] Run B PG fault/reconstruction regressions: fail user/role/outbox save, concurrency winner/loser, registration response lost vs duplicate email, first-DOB repeat, reloaded committed revision in a new context produces same envelope, already-serialized outbox recovery preserves original bytes. Verify safe fresh-scope behavior after failed Identity save. (FR-001/002/003/005/006/009/011; SC-001/004/006)

## Phase 4 — US2: PR B, controlled DOB correction

**Goal**: Accountable source corrections without new entitlement effects. **Independent test**: Admin command replay/conflict/rollback and receipt of its fact by PR A.

- [ ] T015 [US2] Add failing B command/API and PG regressions in CustomerFactsTests/CustomerFactsPostgresTests: Admin vs user access, server actor, required reason/date/no-change, expectedRevision, exact replay after a subsequent correction, reused identity with changed actor/user/date/reason, A→B→A, simultaneous same-revision commands and rollback/lost actual commit acknowledgement. (FR-004/005/009/011/012)
- [ ] T016 [US2] Implement B `src/Cinema.Application/Users/Commands/CorrectDateOfBirth/*`, narrow writer operation and `UsersController` endpoint proposed in plan.md. Persist old/new DOB, actor/reason/operation/result and next revision with account/outbox in one transaction; replay before expected-revision check. Add current revision/nullable facts to admin UserDto/mapping. Do not change legacy birthdayDate financial projection or emit legacy birthday-grant message for corrections. (FR-003/004/005/010/012)
- [ ] T017 [US2] Add producer/consumer contract tests using stored correction snapshot, unknown historical baseline and original DOB first-set timestamp. Add L compatibility assertions that registration/correction/duplicate facts alter zero balance/ledger/tier/GOLD/achievement/grant rows and never rewrite legacy DOB projection. Retain existing initial-DOB financial flow regressions. (FR-002/004/009/010/011/012; SC-001/002/005/006)
- [ ] T018 [US1] [US2] Verify complete PR B locally before commit: domain/handler/API, actual PG Identity/Bus Outbox and fresh/upgrade migration checks, real broker outage/new publisher recovery; full required Release build/suite, git diff --check. Document additive rollout and factual-only correction behavior in existing setup docs. Inspect actual failures/skips; no commit or push implied. (FR-001…012; SC-001/002/004/005/006)

**Checkpoint B**: Account mutation/audit/outbox/tests remain one cohesive backend PR. No unsafe release separating facts from their producer transaction. B emission requires all active reader replicas from A; original backend branch remains untouched.

## Phase 5 — Final committed-pair verification (after separate Git authorization)

- [ ] T019 Revalidate final A+B SHA pair and create/use clean external pinned checkouts only after authorized commits. Re-read B/L AGENTS and central artifacts; check runner guards/test discovery and ensure unrelated .tmp worktrees are not selected. Do not alter existing assertions or bypass clean-checkout guards. (FR-006/010; all stories)
- [ ] T020 Add/run focused cross-service customer-facts E2E through L `test/e2e/customer-facts.transport-spec.ts` and existing runners: actual registration, both first-DOB APIs, authorized correction/replay, gap/out-of-order/restaging from B persisted revision, source broker outage/restart. Check DB facts/audit/projection and zero new financial effects; distinguish exact command replay, manual duplicate and real unacked redelivery. Record exact SHA pair/exits/evidence. (FR-001…013; SC-001…006)
- [ ] T021 Run sequential B `LOYALTY_REPO=<pinned L> bun tests/checkout-e2e/run.mjs`, then L `MONOLITH_REPO=<pinned B> bun run test:transports`; include focused customer-facts suite wiring if the current runner needs it. Existing paid checkout/deduct/refund/GOLD/intents/outbox assertions remain strict. Nonzero/skipped/blocked results are not passes. Inspect cleanup of only own containers/volumes/networks. (FR-006/010/013; SC-004/005)
- [ ] T022 Final scoped diff/contract/constitution review and user report: actual base/head pair, tests and remaining gates, null legacy facts, pending/BLOCKED evidence, consumer-before-producer requirement, audit/replay/privacy and explicit Stage 5/6 exclusions. No automatic merge/deploy/reset or implementation of later stages. (FR-009/010/011/012/013; SC-003/005/006)

## Dependencies and execution strategy

`T001 → T002 → T003 → T004 → T005 → T006/T007 → T008 → T009 → A review/authorized commit`

`T002 + A contract → T010 → T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → B review/authorized commit`

`authorized final A+B commits → T019 → T020 → T021 → T022`

US3 executes before source stories to make consumer-first deployment safe. US1 and US2 are reviewed as one backend PR because they share User locking/audit/transaction semantics. Consumer work is independently verifiable using agreed fixtures. No parallel task marker is assigned to shared schema/User/writer files. If different people work in separate repositories, only test-fixture preparation after T002 is independent; integration waits for the agreed committed pair.

T009/T014/T018 are dirty-worktree pre-commit checks. T019–T022 require separately authorized commits and clean pinned checkouts. Task completion does not itself authorize a commit, PR, migration on shared infrastructure or automatic implementation. During backend-only work, report progress in chat rather than writing central checkboxes as a side effect.

## Requirements coverage / exit criteria

| Requirement | Main implementation / regression tasks |
| --- | --- |
| FR-001 | T010–T012, T014, T018, T020 |
| FR-002 | T010–T014, T017, T020 |
| FR-003 | T002–T005, T010–T014, T016, T020 |
| FR-004 | T015–T018, T020 |
| FR-005 | T003–T006, T008, T010–T016, T018, T020 |
| FR-006 | T007–T009, T012–T014, T018, T020–T021 |
| FR-007 | T003, T005, T008, T020 |
| FR-008 | T003–T006, T008, T020 |
| FR-009 | T002–T005, T010–T011, T014–T015, T017, T022 |
| FR-010 | T007, T009, T013, T016–T018, T020–T022 |
| FR-011 | T002–T004, T010–T011, T014–T015, T017, T022 |
| FR-012 | T002–T003, T005, T007–T009, T015–T018, T022 |
| FR-013 | T006–T009, T020–T022 |

SC-001 → T010/T014/T017/T020; SC-002 → T015/T018/T020; SC-003 → T003/T006/T008/T020; SC-004 → T006/T008/T014/T018/T020/T021; SC-005 → T007/T009/T017/T020/T021; SC-006 → T002/T010/T011/T014/T017/T020.

Exit requires all applicable local and final pair gates with actual evidence; no test, migration or financial-policy activation is claimed by this unchecked planning checklist. Any unavailable infrastructure/test-only ACK barrier remains an explicit blocker for that acceptance claim, not permission to weaken it.
