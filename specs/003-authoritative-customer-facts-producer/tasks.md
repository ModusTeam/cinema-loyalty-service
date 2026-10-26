# Tasks: Authoritative Customer Facts Producer — PR 2B

**Input**: [spec.md](spec.md), [plan.md](plan.md), central master and constitution.
**Status**: Planning only; every checkbox is future work, not permission to execute.
**Revision**: 2 — transaction proof first; correction operation deferred.
**Scope**: B = backend implementation worktree; L = read-only pinned loyalty checkout. No correction writer/internal operation or new public correction API; no L production changes. One backend PR with cohesive transaction guarantees.

Each task states dependencies, acceptance, test level and main risk. Proposed new file names are implementation targets, not files created during planning. Tasks grouped by user story; shared foundations precede all stories. No automatic commit/push/migration/reset or Full SDD Cycle.

## Phase 1 — Safe setup and first-slice transaction proof

- [ ] T001 Recheck B/AGENTS.md, L/AGENTS.md and both Git baselines; after implementation approval create isolated B worktree from current origin/main, hand off absolute read-only paths to these artifacts and L/.specify/memory/constitution.md. **Depends:** user implementation approval. **AC:** AC-09; preserve old checkout/002, record exact SHAs. **Level:** Git/static. **Risk:** implementing old compensation branch or losing local artifacts.
- [ ] T002 Prove transaction wiring **before the source model** in B/tests/Cinema.OrdersTests/CustomerFactsPostgresTests.cs, reusing OrderReservationPostgresTests.cs fixtures and the existing schema. Use real UserManager/RoleManager, assert shared scoped ApplicationDbContext/store/scoped Bus Outbox, production EnableRetryOnFailure(3), explicit begin/body/commit and only minimal B/src/Cinema.Infrastructure/Services/CustomerFactsExecutionStrategy.cs if needed. Cover checked role assignment, intermediate saves, representative staged message, commit and injected pre-commit failures; fresh scope must see all user/role/outbox writes or none. Prove broker-down DB staging, no implicit callback replay, and separate actual-commit/response-loss behavior. **Depends:** T001 and verified disposable fixture/resources; no T003–T006 dependency or new source migration. **AC:** preliminary AC-04/05 and FR-004/006/012; final head/history proof remains T007/T012. **Level:** real PostgreSQL with actual Identity/Bus Outbox, no mock substitute. **Risk:** wrong DI scope, unsupported explicit transaction or save/retry behavior; if proof fails, stop before source model and fix narrow wiring without weakening guarantees.

## Phase 2 — Shared contract and source foundations

- [ ] T003 Add contract/calendar regression tests in B/tests/Cinema.OrdersTests/CustomerFactsTests.cs against fixed L/src/loyalty/dto/customer-facts-changed.dto.ts semantics: registration/first-set mapping, explicit nulls, UTC milliseconds, leap dates, UUIDs, known/unknown roots and invalid combinations. Retain DateOfBirthCorrected v1 type/serialization compatibility fixtures without implementing its writer. **Depends:** successful T002. **AC:** AC-03/06; accepted-operation registeredAtUtc is authoritative only on commit, not a physical DB commit timestamp; no age-rule unification. **Level:** unit. **Risk:** default .NET serialization rejected by Zod.
- [ ] T004 Define fixed v1 records/mapping in B/src/Cinema.Application/Common/Contracts/CustomerFactsChangedIntegrationEvent.cs; extend B/src/Modules/Identity/Cinema.Identity.Domain/User.cs with protected source head/timestamp mutations; add immutable B/src/Cinema.Domain/Entities/CustomerFactRevision.cs source snapshot. **Depends:** T003. **AC:** FR-001/003/005/008, AC-03; complete v1 shape retained, no correction operation/audit/result store or L contract changes. **Level:** unit. **Risk:** divergent persisted fields and serialized snapshot.
- [ ] T005 Map source fields/history/checks/uniqueness in B/src/Cinema.Infrastructure/Persistence/Configurations/UserConfiguration.cs, CustomerFactRevisionConfiguration.cs, ApplicationDbContext.cs; reject ordinary history update/delete and immutable timestamp changes; generate one additive migration/designer/snapshot under B/src/Cinema.Infrastructure/Migrations. **Depends:** T004. **AC:** AC-03/06; legacy null/0 preserved; mapped Identity table name verified, no backfill or correction-only columns/indexes. **Level:** model + disposable PG migration. **Risk:** default-now invents history; ordinary Identity save bypasses protection. Migration execution only on verified authorized fixture.
- [ ] T006 Add common B/src/Cinema.Application/Common/Interfaces/ICustomerFactsWriter.cs and narrow B/src/Cinema.Infrastructure/Services/CustomerFactsWriter.cs; register in ConfigureInfrastructureServices.cs. Reuse the transaction mechanism already proven in T002, including CustomerFactsExecutionStrategy.cs if needed; do not recreate a second strategy. Establish one-context transaction/lock/reload/stage helpers for actual source head/history, including checked head+1 allocation and Int32.MaxValue rejection. **Depends:** T005 and successful T002. **AC:** FR-004/007/012, AC-04; no independent nested tx, external broker work or correction method; global retries retained. **Level:** unit plus real-PG full-model smoke. **Risk:** source writes introduce a new context/save outside the proven boundary.

## Phase 3 — US1: Atomic registration

- [ ] T007 [US1] Write failing real-store registration/role/outbox regressions in B/tests/Cinema.OrdersTests/CustomerFactsPostgresTests.cs using EnableRetryOnFailure(3): rejected create, missing/failed role, staging/final-save failure after intermediate save, duplicate/concurrent registration and committed source reload. **Depends:** T006. **AC:** AC-01/03/04; failures leave no account/role/history/publishable fact. **Level:** PG with real UserManager/roles/scoped Bus Outbox. **Risk:** mocked Identity conceals implicit saves.
- [ ] T008 [US1] Route B/src/Cinema.Infrastructure/Services/IdentityService.cs RegisterAsync through the checked atomic operation; retain B/src/Cinema.Application/Auth/Commands/RegisterUser/RegisterUserCommand.cs and Host AuthController contract. Capture one UTC millisecond instant of the accepted registration operation, authoritative only after commit and never described as exact physical commit time; check Create/AddToRole; stage Registered and commit. **Depends:** T007. **AC:** AC-01/03/04, existing duplicate API semantics. **Level:** unit/PG. **Risk:** role failure returns success or unknown commit automatically replayed.
- [ ] T009 [US1] Cover and update only new-admin branches of B/src/Cinema.Infrastructure/Seed/IdentitySeeder.cs and Persistence/ApplicationDbContextInitializer.cs using same atomic creation primitive; preserve default roles/config and unrelated catalog seed code. **Depends:** T008. **AC:** AC-01/06; existing admin/role repair no fabricated facts; startup-before-bus stages durably with broker unavailable. **Level:** PG and seed lifecycle. **Risk:** seeding bypasses source writer or requires full bus network startup.

**US1 independent exit:** API and both executable new-account paths commit one truthful registration fact with required role, or roll back completely; legacy users remain unknown. This slice is reviewable, not independently deployed before remaining producer paths are ready.

## Phase 4 — US2: Both first-DOB routes

- [ ] T010 [US2] Add failing handler/PG tests in B/tests/Cinema.OrdersTests/CustomerFactsTests.cs and CustomerFactsPostgresTests.cs for SetMyDateOfBirth and UpdateProfile: null/same/different dates, route validators, explicit legacy root, first-set immutable timestamp, generic+legacy+new messages. **Depends:** T006/T008. **AC:** AC-02/03/06/08; zero new revision for no-op/name-only updates. **Level:** unit/PG. **Risk:** changing business validation or duplicate bonus event.
- [ ] T011 [US2] Wire B/src/Cinema.Application/Account/Commands/SetMyDateOfBirth/SetMyDateOfBirthCommandHandler.cs and UpdateProfile/UpdateProfileCommandHandler.cs to the shared transaction; lock/reload before guard, stage matching legacy/new source state and preserve HTTP result semantics/aliases. **Depends:** T010. **AC:** AC-02/04/08; all related messages/user/history commit together. **Level:** unit/PG. **Risk:** legacy send saved before transaction or stale tracked user survives lock.
- [ ] T012 [US2] Add deterministic overlap/failure tests to B/tests/Cinema.OrdersTests/CustomerFactsPostgresTests.cs: both DOB handlers race via real row-lock barrier; one winner, no losing fact; revision exhaustion rejects without source/outbox change; role/password/name update races cannot overwrite facts; rollback after first staged legacy message; actual commit then injected response loss. **Depends:** T011. **AC:** AC-02/04; fresh scope verifies all results, transient errors do not allocate extra revision. **Level:** real PG with production retry config and transaction interceptor. **Risk:** Promise.WhenAll alone fails to force overlap; commit loss mislabeled rollback.

**US2 independent exit:** every current first-DOB route and HTTP alias has the same preserved behavior plus authoritative first-set evidence; losing writers emit nothing.

## Phase 5 — US3: Audit, restaging and recovery

- [ ] T014 [US3] Add focused stored-history restaging mode in B/src/Tools/Cinema.DbUpdater/Program.cs and CustomerFactReplayOperations.cs, with tests in B/tests/Cinema.DbUpdaterTests/DbUpdaterCliTests.cs and CustomerFactsPostgresTests.cs. Mode must not apply migrations/seeding, start unrelated infra, allocate revision or restage legacy benefits; stage stored v1 snapshot via scoped Bus Outbox only. **Depends:** T004 serialization, T005 immutable history and T006 scoped outbox/transaction; no correction operation dependency. **AC:** AC-03/05; missing evidence fails; repeat replay preserves original identities/content. **Level:** CLI/PG/raw-serialization regression. **Risk:** updater default migration path or JSON double encoding.
- [ ] T015 [US3] Add bounded real broker outage/restart and serialized outbox retry tests in B/tests/Cinema.OrdersTests/CustomerFactsPostgresTests.cs (reuse existing fixture). Distinguish retry of serialized message, fresh-scope history reconstruction and explicit restage after outbox cleanup; verify identical fields and stable MessageId/data.eventId. **Depends:** T009, T012 and T014. **AC:** AC-03/05; commit while broker down, actual restarted delivery host recovers. **Level:** real PostgreSQL/RabbitMQ. **Risk:** mock Send/privately invoked worker method presented as crash recovery.
- [ ] T016 [US3] Add focused B/tests/checkout-e2e/customer-facts-probe.mjs and minimal explicit runner selection in B/tests/checkout-e2e/run.mjs. Exercise real registration/first-DOB HTTP aliases → passive L projection; manual duplicate, actual produced revision2 before revision1, identity conflicts, valid other user, legacy first-DOB dedupe and zero passive financial effects. Retain unchanged L correction/contradictory-predecessor compatibility fixtures as separate evidence, not a requirement to implement correction generation. Reuse L/test/rmq/customer-facts.transport-spec.ts real post-commit/pre-ACK seam for independent lost-ACK gate without production changes. **Depends:** T015. **AC:** AC-05/08; assertions distinguish broker redelivery flag from manual republish; final execution waits T019. **Level:** transport/E2E fixture implementation. **Risk:** existing runner only selects checkout suite; uninstrumented lost-ACK claim.

**US3 independent exit:** original source facts remain replayable after delivery and restart; consumer evidence is contiguous or explicitly pending/blocked, not invented or financially applied.

## Phase 6 — Verification and handoff (no automatic publication)

- [ ] T017 Review B diff against all production write paths; update existing B/src/Tools/Cinema.DbUpdater/README.md and relevant existing setup docs with consumer-first rollout, additive schema, immutable-history restage and no-safe-old-writer rollback constraints. **Depends:** T016. **AC:** AC-09; no new public correction API or unrelated auth/payment/schema edits, no duplicated master. **Level:** static/contract review. **Risk:** old competing consumers or old DOB writers invalidate new history.
- [ ] T018 Run pre-commit B focused unit/real-PG tests, fresh/prior migration fixture checks, `dotnet build Cinema.sln -c Release`, `dotnet test Cinema.sln -c Release` with verified disposable infra and `git diff --check`; record actual exits/counts/skips/cleanup in review handoff. **Depends:** T017. **AC:** AC-01…06/09; production retries enabled, no silently skipped PG tests; deferred AC-07 is not a gate. **Level:** unit/PG/build. **Risk:** treating absent fixture as passed or mutating shared DB. Stop before commit unless separately authorized.
- [ ] T019 After separately authorized commits only, record clean B implementation HEAD and L master HEAD including PR 2A; sequentially run B `LOYALTY_REPO=<L> bun tests/checkout-e2e/run.mjs` with explicit customer-facts probe and L `MONOLITH_REPO=<B> bun run test:transports`, plus same-SHA L `bun run test:rmq` lost-ACK evidence if not shared by combined harness. **Depends:** T018 and separate Git authorization. **AC:** AC-05/08/09; exact pair, exit0, real delivery, no clean-checkout guard bypass. **Level:** committed SHA-pinned cross-service E2E/transport. **Risk:** testing uncommitted/old pair or claiming parent coverage proves subprocess behavior.
- [ ] T020 Finalize acceptance matrix against B/tests results and central specs/003-authoritative-customer-facts-producer/spec.md; distinguish completed checks, blocked gates, deferred correction operation, mock payment boundary and rollout prerequisites. **Depends:** T019. **AC:** all current AC-01…06/08/09 with evidence; deferred AC-07 is excluded; only then request separate publication/release approval. **Level:** evidence review. **Risk:** marking planning/tests as deployment authorization. No implementation of later stages.

## Dependencies and reviewable slices

`T001 → T002 (PG proof) → T003 → T004 → T005 → T006 → T007 → T008 → T009`; `T006/T008 → T010 → T011 → T012`; `T004/T005/T006 → T014`; `T009/T012/T014 → T015 → T016 → T017 → T018 → (separate commit authorization) → T019 → T020`. T013 is deferred and is not a dependency of any current task.

Review slices: (1) T002 transaction proof on existing schema; (2) contract/model + registration and seeders; (3) both DOB paths/concurrency; (4) restaging/delivery recovery and evidence/docs. They belong to **one narrow backend PR**, not independently deployed partial producers. No deployed intermediate state can admit a changed user without its required fact/outbox; all existing registration/DOB writers must be covered before activation.

19 active tasks: setup/proof 2, shared foundations 4, US1 3, US2 3, US3 3, final gates 4. T013 is retained only as a backlog reference; existing IDs are not renumbered. Test-first tasks precede the corresponding implementation where practical. No task is marked [P]: shared writer/model/fixture changes would overlap. Restaging is logically independent of correction even though the normal implementation order may remain sequential. Do not spawn agents or run parallel mutable fixture stacks as a side effect of this checklist.

## Deferred backlog — not an implementation or exit gate

Original **T013 / FR-009 / AC-07** moves to a future separately approved correction PR: trusted actor/reason, expected revision, stable operation identity, audit/historical result, exact replay after later correction, conflicts and A→B→A. No correction-only schema, internal method or tests are required in PR 2B. Complete DateOfBirthCorrected v1 compatibility remains under T003/T004; ordinary registration/first-set revision constraints and max guard remain current requirements.

## Current FR → AC → task traceability

| FR | Current AC | Tasks |
| --- | --- | --- |
| FR-001 | AC-01/06 | T004/T005/T007/T008/T009 |
| FR-002 | AC-02/06 | T010/T011/T012 |
| FR-003 | AC-01/03 | T003/T004/T005/T007/T008/T014/T015 |
| FR-004 | AC-01/04 | T002/T006/T007/T008/T011/T012 |
| FR-005 | AC-03/05/08 | T003/T004/T015/T016/T019 |
| FR-006 | AC-01/05 | T002/T007/T008/T015 |
| FR-007 | AC-02/04 | T005/T006/T010/T011/T012 |
| FR-008 | AC-03/05 | T004/T005/T014/T015 |
| FR-010 | AC-02/08 | T010/T011/T016/T019 |
| FR-011 | AC-03/06 | T003/T004/T005/T007/T008/T010 |
| FR-012 | AC-04/09 | T002/T007/T012/T017/T018 |
| FR-013 | AC-08/09 | T016/T017/T019/T020 |

AC-09 is the cross-cutting evidence/rollout gate for all current FR, not a reintroduction of FR-009. AC-07 is deferred. Run final gates only after all dependencies; do not interpret the table as optional tests.

## Exit gate

All FR and AC mapped; no new economy or L production changes; all Identity create/DOB writers covered; actual PG/real RMQ and clean committed pair evidence available; exact duplicates and conflicting facts tested; no migrations/deployment/publication without separate permission. No current task is marked complete merely because this planning document exists.
