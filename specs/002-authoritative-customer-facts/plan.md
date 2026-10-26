# Implementation Plan: Authoritative customer facts

**Feature**: `002-authoritative-customer-facts` | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)
**Status**: Proposed design; planning only. Two coordinated PRs; implementation requires separate approval.

## Summary

Backend persists truthful registration/first-DOB timestamps and immutable per-customer revisions, including controlled DOB correction audit. Loyalty receives a separate facts-only contract into durable history and a contiguous projection. Existing first-DOB financial behavior stays on its existing contract until the later birthday activation stage. A new fact never calls birthday grants, tier recalculation or accounting.

Research, data model, contract and verification are consolidated here under the existing SDD workflow; no duplicate research/contracts/quickstart documents or second Spec Kit project.

## Technical Context and baseline

| Repository | Actual local checkout before planning | Verified remote after fetch / implementation baseline |
| --- | --- | --- |
| L: cinema-loyalty-service | master, `ea969769d775bf2e3f5d005d33a353167b41424f`; clean | origin/master, same SHA |
| B: cinema-platform-back | fix/gold-checkout-compensation, `7aa5a5c5f9e5bdf7ad0b69feb8e1e48b2681253d`; clean | origin/main, `f5bb441d8a7c8fe9be4bcda73a457c4ce6fb4f43` |

Backend evidence is read from `git show origin/main:<path>`, not the older checked-out branch. `f5bb441` merges PR #80 containing `9522ebb` and `62d8903`: PaidAt/sessionId/payment facts already exist. Do not repeat PR 1. No checkout/merge/rebase or application change occurred during planning.

Stack: existing .NET 10/EF Core 9/MassTransit EF Bus Outbox/PostgreSQL in B; NestJS 11/Prisma 7/PostgreSQL/RabbitMQ in L, Bun 1.3.13 scripts, Node.js 22 runtime, Jest. No dependency/framework change. Scope is customer facts and their ingestion, with bounded recovery using existing scheduling infrastructure.

### Cross-repository handoff

L is the sole SDD root. Future sessions receive absolute read-only paths to constitution, master and these three artifacts. Map B/ and L/ to separately authorized worktrees based on freshly fetched remote defaults. Preserve original backend `fix/gold-checkout-compensation` and unrelated files. Do not copy master or install Spec Kit in B; do not update central task checkmarks as backend implementation side effects.

Proposed branches, not created: L `feat/customer-facts-ingestion`; B `feat/authoritative-customer-facts`. Read target AGENTS.md again. Authorization must name the PR half; skills do not authorize Full SDD Cycle, implementation, commit, push, migration, reset or deployment.

## Constitution Check

- Minimal scope: two repository PRs sharing one contract; no service extraction, generic event framework, new broker/queue or auth redesign.
- Atomicity: account + revision/audit + Bus Outbox share one DbContext/transaction; receipt/projection share the existing Prisma transaction and profile lock.
- Persistent identity: `(userId, revision)`, eventId and correction operation identity enforced in PostgreSQL. Byte hashes are not business dedupe.
- Recovery: at-least-once; ACK after receipt/projection commit or durable quarantine; already-ACKed pending receipts recover from PostgreSQL.
- Evidence: real PG concurrency/rollback and RMQ, exact SHA pair for cross-service gates; no test result claimed during planning.
- Ownership/calendar: backend owns factual instants; no now/profile-createdAt backfill; Kyiv rules are not replaced by process timezone.
- Operations: disposable resources only after authorization; preserve ledger/refund/GOLD/intents/outbox. No constitution exception required.

## Research: current code evidence

B locations are at origin/main; L locations are current HEAD.

| Evidence | Assessment |
| --- | --- |
| B `src/Modules/Identity/Cinema.Identity.Domain/User.cs:5`; `src/Cinema.Infrastructure/Persistence/Configurations/UserConfiguration.cs:18` | User contains names and DateOfBirth only; DOB has a UTC DateTime converter. Confirmed missing RegisteredAt, DobFirstSetAt and fact revision. |
| B `src/Cinema.Infrastructure/Services/IdentityService.cs:16–38` | CreateAsync saves user, AddToRoleAsync saves separately; no customer fact/outbox staging, role result unchecked. Adding Send after CreateAsync alone would leave an account without its fact on staging failure. This is a targeted transaction concern, not a general auth audit. |
| B `src/Cinema.Application/Account/Commands/SetMyDateOfBirth/SetMyDateOfBirthCommandHandler.cs:26–67`; `.../UpdateProfile/UpdateProfileCommandHandler.cs:28–94` | Both perform first DOB writes and stage a legacy message before UserManager.UpdateAsync. Retain Identity concurrency protection; no untested claim that concurrent writes both currently succeed. |
| B `src/Cinema.Application/Common/Contracts/UserDateOfBirthSetIntegrationEvent.cs:14–17` | Only userId/dateOfBirth/occurredAtUtc, no stable eventId/revision or registration/first-set facts. Each construction captures current handler time. |
| B `src/Cinema.Infrastructure/ConfigureInfrastructureServices.cs:148–155`; ApplicationDbContext | Scoped EF Bus Outbox and Identity stores already share the context. User is IdentityUser, not BaseEntity: BaseEntity domain-event dispatch does not cover it automatically. |
| B `tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs:454–568` | Existing PG Identity/DOB + outbox success/rollback fixture is reusable; it does not verify new registration multi-save atomicity or revisions. |
| B UsersController/UserService | Admin list/role changes exist; relevant source search found no controlled DOB correction command/audit. Missing capability, not a security finding. |
| L `src/loyalty/loyalty.service.ts:430–474` | Locks profile, unconditionally updates birthdayDate, may grant current UTC-year bonus. eventId/occurredAtUtc do not select a revision. Lock serializes writers but cannot detect stale delivery. |
| L `src/loyalty/consumers/user-date-of-birth-set.consumer.ts:20–37`; DTO lines 3–18 | Aliases and delivery wrapper exist. Metadata alone does not implement ordering/passive ingestion. |
| L `src/loyalty/consumers/rmq-delivery.service.ts:90–106`; InboundDelivery | Queue/body transport hash; completed legacy DOB cycles intentionally restart. A→B→A setter support is not revision dedupe. Keep that reset limited to legacy operation. |
| L Prisma LoyaltyProfile lines 44–69; UserBonusGrant unique(userId,type,grantYear); `src/prisma/profile-transaction.ts` | Profile date/createdAt and birthday grant uniqueness are not source history. Preserve profile→source/history→projection lock order and financial dedupe. |

Confirmed contract limitations: missing facts/identity and possible stale DOB overwrite under reordered events, established by inspection, not newly reproduced runtime failures. Future risks requiring tests: partial registration/outbox commit, retrying tracked Identity work, revision races, gap recovery and accidental bonus activation.

## Contract and source model

### Backend persistence

Add private-set `RegisteredAtUtc?`, `DobFirstSetAtUtc?`, `CustomerFactsRevision` (initial 0 for existing/unknown accounts) to User. No database `now()` default or timestamp backfill. New RegisterAsync explicitly records actual registration; first null→DOB transition records first-set time. Later corrections change neither known timestamp. Existing DOB with unknown first-set remains null. Seed/admin/fixture-created accounts without evidence remain unknown; seeding/import execution is not customer registration.

Use one append-only `CustomerFactRevision` table as audit/reconstruction storage, not event sourcing. Columns: EventId UUID PK; UserId; Revision positive Int; Kind; OccurredAtUtc; RegisteredAtUtc/DobFirstSetAtUtc nullable; DateOfBirth/PreviousDateOfBirth nullable date; CorrectionOperationId nullable UUID; ActorUserId/Reason nullable; stored correction result/command fingerprint. Unique `(UserId, Revision)` and unique non-null CorrectionOperationId. Audit is not overwritten by account edits or cascaded away on routine update. User remains source of truth; immutable snapshots reconstruct messages without querying mutable account fields.

Choose factual UTC instants at **millisecond precision before persistence/serialization**, shared by .NET, PostgreSQL and JavaScript Date. Use `timestamp(3) with time zone`; audit DOB uses `date`. This avoids .NET/PG sub-millisecond values being truncated by Prisma and becoming apparent conflicts. Existing DOB API/storage representation can remain; normalize calendar date via one narrow mutation, not by converting birth midnight between zones. Keep existing age limits and self-service API shapes.

Kinds: `Registered`, `DateOfBirthSet`, `DateOfBirthCorrected`. New accounts start at Registered revision 1. A pre-existing account can start its stream at revision 1 on an actual new DOB mutation/correction with null unknown historical timestamps; that root is not recovered registration history. Name-only/same-DOB UpdateProfile creates no fact. Same-date support correction is rejected as no change.

### New versioned envelope

Raw JSON on existing `queue:loyalty_ticket_purchased`, distinct pattern **`CUSTOMER_FACTS_CHANGED`**, schemaVersion 1. Existing USER_DATE_OF_BIRTH_SET invokes financial behavior; registration/correction cannot safely reuse it.

| data field | Meaning / validation |
| --- | --- |
| schemaVersion | Exactly 1; unknown future version is permanent quarantine |
| eventId | Persisted UUID per revision; unchanged on retry/reconstruction |
| userId | Authoritative Identity UUID; stream = backend customer/userId |
| revision | Integer 1..2147483647; increment under source lock; never recycle |
| kind | Registered / DateOfBirthSet / DateOfBirthCorrected |
| occurredAtUtc | Persisted source mutation time, UTC ISO-8601 milliseconds; never delivery time |
| registeredAtUtc | Registration instant or explicit null for unknown history |
| dobFirstSetAtUtc | First-declaration instant once known, otherwise explicit null |
| dateOfBirth | Current `YYYY-MM-DD` or null, a real calendar date |
| previousDateOfBirth | Old date for correction; null for other kinds |
| correctionOperationId | UUID for correction, otherwise null; audit reference |

All fields are explicit, including nulls. Registered has known registration and null DOB/first-set; first-set has known first-set and DOB; correction has previous/current DOB and preserves known timestamps. Reject invalid/non-UTC timestamps, invalid dates and inconsistent kind shapes. Do not reject valid source time merely because it is ahead of the receiving replica clock. Semantic comparison includes all defined fields; JSON order/transport headers are irrelevant. Omit email, name, passwords, support reason and arbitrary private metadata.

Keep existing USER_DATE_OF_BIRTH_SET for **initial DOB only**, staged from the accepted source revision in the same transaction. Persisted eventId may be added; existing occurredAtUtc uses persisted DobFirstSetAtUtc. Existing aliases/routing/grant behavior remain. Registration, correction and facts-only replay never emit this legacy financial message. `user.profile_updated` retains its current profile use/routing. This bounded bridge preserves the **active** legacy behavior; it is not a dual economy for obsolete balances. Its retirement belongs to approved Stage 6 activation.

Explicit intermediate behavior: correction updates authoritative User and new facts projection, but does not switch legacy financial `LoyaltyProfile.birthdayDate` or recompute benefits. Describe the support operation as factual correction; full birthday entitlement effects are not complete here. Later Stage 6 must use B.4's correction anniversary restrictions and consumed-entitlement history. This boundary avoids silently activating new or unsafe birthday behavior.

## Source transactions and correction API

1. Registration: choose identity/time once → begin transaction → CreateAsync/check IdentityResult → AddToRoleAsync/check result → persist revision 1 and stage envelope via scoped Bus Outbox → SaveChanges → commit. Identity intermediate saves stay in this transaction. Role/staging/save failure rolls back the unit. Retain normalized-email uniqueness and current duplicate-registration response.
2. Both first-DOB routes: begin short transaction → lock User row (`"AspNetUsers"`, verify EF column mapping) → reload → set-once/current state check → timestamp/revision/audit → stage new fact and applicable existing notifications → UpdateAsync/SaveChanges → commit. Same mutation/transaction owner for both routes; preserve ConcurrencyStamp. Names-only edits produce no fact.
3. Correction: Admin → lock target User → check persistent operation identity **before** stale-revision check → exact historical replay or content conflict → compare expectedRevision → require existing DOB/changed value → preserve timestamps, append revision/audit, stage only new fact → commit. A→B→A creates a correction revision, never a fresh first-set time.

Proposed narrow API: `PATCH /api/users/{id:guid}/date-of-birth`, existing Admin authorization. Body: operationId, expectedRevision (0 for existing stream not started), dateOfBirth date-only, reason trimmed 1..1000 characters. Actor from authentication, never body. Response: userId, accepted revision/eventId, corrected date; exact replay returns stored result after later corrections. 401/403 authorization; 404 missing user; 409 stale revision/identity reuse; 400 malformed/no-change. Existing self-service routes/responses unchanged. Add current revision/nullable timestamps to admin UserDto/mapping so caller can get expectedRevision; no history/support UI. Command equality includes target, actor, expected revision, DOB and reason.

Production Npgsql uses EnableRetryOnFailure: naked manual transactions outside an execution strategy fail. Wrap the **whole local transaction** in EF's nonretrying execution-strategy facility, following checkout's discipline without depending on Orders' internal CheckoutExecutionStrategy or adding a generic UoW. Retain global retry configuration. Do not automatically replay tracked UserManager work; discard failed scope/tracking. No network publication inside the transaction: scoped production Bus Outbox endpoint only, not IBus/direct broker. Verify role/user/outbox resolve to the same ApplicationDbContext.

Unknown commit response is not rollback. Persisted revision/outbox is authoritative. Correction replay finds operationId; registration retains duplicate-account semantics without a second user/fact; first-DOB repeat may keep current AlreadySet response. Do not redesign registration recovery or refresh-token behavior.

## Loyalty ingestion and durable recovery

Proposed Prisma models:

- `CustomerFactsProjection`: userId PK, appliedRevision default 0, sourceEventId/occurredAtUtc, registeredAtUtc/dobFirstSetAtUtc nullable, DOB date nullable, lastAppliedAt. Revision 0 means unknown, not a registration fact. Separate from financial/legacy-date fields.
- `CustomerFactReceipt`: eventId UUID PK; unique `(userId, revision)`; immutable validated source payload/fingerprint; receivedAt; `PENDING/APPLIED/BLOCKED`; appliedAt/errorCode nullable. Retain original fact envelope for review/replay after ACK. Existing unique tuple supports next-revision lookup; add a state index only for the actual recovery query and verify SQL/EXPLAIN.

One CustomerFactsService provider in LoyaltyModule, thin new consumer/DTO. No new Nest module, gRPC or BullMQ queue.

Validate → withTransactionRetry → lockLoyaltyProfile(createIfMissing=true) → ensure projection → check **both** eventId and user/revision identities/content → insert receipt → apply contiguous revisions from appliedRevision+1 → commit → delivery wrapper may ACK. Local profile/projection createdAt is never RegisteredAt. Exact duplicate PENDING/APPLIED/BLOCKED receipt is a no-op; arbitrary changed content is not silently ignored.

Predecessor validation: registration timestamp is stable; known first-set timestamp is not replaced; first-set/correction and previousDOB agree with accepted predecessor; later revision cannot clear known DOB/first-set. An earlier Registered snapshot legitimately has null first-set. Explicitly unknown pre-existing stream roots are valid as above. Direct conflicting identity/content throws a permanent error to existing durable quarantine without changing accepted facts.

A revision received before its predecessors commits as PENDING and can be ACKed because its original fact is durable. It cannot advance the projection across the gap. If later predecessor validation exposes contradiction, mark that pending receipt BLOCKED with restricted original evidence/error code in the same transaction and retain last valid state. This already-ACKed conflict cannot depend on another delivery or throw away its only evidence. No DOB/reason/payload logs.

Bound processing: 50 consecutive revisions per user transaction; recovery tick at most 50 candidate users, one profile transaction each. Add a small recovery method using existing Nest Schedule (e.g. 10-second interval, no business deadline). Select only users with their **next** revision PENDING; gaps/BLOCKED chains do not hot-loop. Profile locks serialize replicas and event/job races; no new lease framework for DB-only work. Failed ticks leave receipts durable; restart resumes. Any batch traversal uses stable seek boundaries, never cursor+skip over a mutating filter.

Extend RmqDeliveryService Operation and safe permanent error codes, preserving retry budget/backoff/quarantine/replay. Completed-cycle reset remains limited to legacy UserDateOfBirthSet. Business dedupe lives in the receipt transaction. Legacy messages cannot initialize/overwrite authoritative history or fill unknown timestamps.

Missing source revisions require investigation/restaging from backend's retained audit snapshot through Bus Outbox with identical eventId/time/content, not direct projection edits. Existing `src/tools/replay-quarantine.ts` covers transport quarantine. BLOCKED chain never auto-skips or auto-overrides the source. No new public repair endpoint; a controlled fixture/internal restaging entry point must demonstrate recovery from stored revisions.

## Project Structure / proposed affected paths

These are future targets; planning modifies no application files.

**B**:
- `src/Modules/Identity/Cinema.Identity.Domain/User.cs`: narrow encapsulated facts/DOB mutations.
- `src/Cinema.Infrastructure/Persistence/Configurations/UserConfiguration.cs`; new `CustomerFactRevisionConfiguration.cs`; ApplicationDbContext; `src/Cinema.Application/Common/Interfaces/IApplicationDbContext.cs`; additive EF migration/designer/snapshot.
- `src/Cinema.Domain/Entities/CustomerFactRevision.cs`: audit entity in existing shared-context layer if needed to avoid invalid Identity.Domain project dependencies; no new project.
- `src/Cinema.Infrastructure/Services/IdentityService.cs`; small shared `CustomerFactsWriter.cs` and Application interface only for the concrete shared transaction responsibility used by registration/two DOB handlers/correction. No generic repository/UoW.
- `src/Cinema.Application/Account/Commands/SetMyDateOfBirth/*`; `.../UpdateProfile/UpdateProfileCommandHandler.cs`; new `src/Cinema.Application/Users/Commands/CorrectDateOfBirth/*`; `Users/Dtos/UserDto.cs`/mapping; `src/Host/Cinema.Api/Controllers/UsersController.cs`.
- New `src/Cinema.Application/Common/Contracts/CustomerFactsChangedIntegrationEvent.cs`; existing DOB contract additive identity/time; existing infrastructure DI.
- New `tests/Cinema.OrdersTests/CustomerFactsTests.cs`, `CustomerFactsPostgresTests.cs` reuse existing project/fixtures; existing Identity outbox regression; `tests/Cinema.DbUpdaterTests/DbUpdaterCliTests.cs`; checkout runner only for focused probe wiring.

**L**:
- Proposed schema models/additive Prisma migration.
- New `src/loyalty/customer-facts.service.ts`, `consumers/customer-facts-changed.consumer.ts`, `dto/customer-facts-changed.dto.ts`; existing LoyaltyModule, enums, RmqDeliveryService, message-failure codes.
- New `test/integration/customer-facts.integration-spec.ts`, `test/rmq/customer-facts.transport-spec.ts`, `test/e2e/customer-facts.transport-spec.ts`; minimal runner/worker-fixture extensions for production wiring.
- Minimal existing reliability/setup documentation for new contract and controlled replay during implementation; no audit report. Preserve strict current-economy assertions.

## PR boundaries and order

**A: loyalty passive ingestion** — contract validation, receipt/projection schema, transactional contiguous application/recovery, PG/RMQ regressions. Can land before producer emits the new pattern; current economy unchanged. Standalone tests use the exact agreed contract fixture, not unmerged backend.

**B: backend authoritative producer/corrections** — User timestamps, source audit, all registration/first-DOB/correction writers, Bus Outbox, tests. Base on updated main including PR #80. Model/producer/audit atomic behavior belongs in this one PR, not unsafe model-only partial releases. B requires A available before emission to shared queue.

Review one shared wire definition. Additive schemas first → all active consumer replicas support new pattern → producer B. Old competing consumers may reject unknown patterns; deploy/stop them before emitting, not rolling mixed consumers blindly. This is minimum compatibility coordination, not elaborate dual-economy deployment. No deployment occurs here.

Existing rows remain unknown/null/revision 0 until actual new facts. No historical timestamp backfill. Unknown evidence is not verified ineligibility; Stage 6 supplies H-8 pre-charge authoritative verification, not a new RPC in this change.

## Verification Plan / mandatory gates

All checks below are future requirements; no application test suite ran during planning.

| Test | Required evidence | FR / SC |
| --- | --- | --- |
| Unit calendar/serialization | Real DOB round-trip/invalid dates/Feb29; UTC millisecond persistence; Dec31 22:30 UTC may be Jan1 Kyiv; delivery delay does not change source date. Preserve original leap-day anchor. | 001/002/009/011; SC-001/006 |
| Unit as-of cutoff fixtures | Evidence at exact Kyiv cutoff vs +1ms; DST shows 30 calendar days differ from 30×24h. Contract/history fixtures only; full anniversary/eligibility calculators remain Stages 5/6. | 008/009; SC-003/006 |
| B PG registration with real scoped Identity/Bus Outbox | User/role/revision/outbox commit together; role/stage/save faults roll all back; fresh-scope reconstruction; normalized-email race has no second registration fact. | 001/003/005/006; SC-001/004 |
| B PG both first-DOB routes | Set once; repeats unchanged; controlled overlapping routes yield one accepted revision and no losing-value event. | 002/003/005; SC-001/004 |
| B PG/API correction | 401/403/404/400/409; expected revision; exact replay after later correction; actor/payload conflict; A→B→A; real concurrency barrier yields one winner. | 004/012; SC-002 |
| B PG rollback/lost commit response | Fail before commit and after actual commit before response; correction replay same result, no second source event; registration does not claim confirmed rollback. | 003/004/005/006; SC-002/004 |
| B/L PG migrations/unknown baseline | Fresh/previous-schema disposable DB; existing users/DOB preserve null unknown times; no default now/backfill. | 009/011; SC-001/006 |
| L PG identity/content | Duplicate/concurrent revisions; reused eventId different user/revision; reused tuple different DOB/time; reordered JSON properties; original accepted history retained. | 003/005/007/012; SC-003/004 |
| L PG reordered/recovery | 3→1→2, permanent gap, >50 pending contiguous receipts, commit then crash before job, next replica resumes, inconsistent pending chain becomes durably BLOCKED. | 008/013; SC-003/004 |
| L PG locks/atomicity/query | Receipt→projection fault rollback; event/job/two-replica overlap under lock; no financial writes; inspect actual pending-next query SQL and EXPLAIN before index choice. | 005/008/010/013; SC-004/005 |
| Real RMQ consumer | ACK after durable receipt; unsupported/malformed/conflicting input quarantined; transient PG failures/restart retain budget; original body/event identity stable. | 006/007/008/012/013; SC-003/004 |
| Real lost ACK | Test-only ACK barrier after commit, independent PG read, close real channel/connection before ACK; require redelivered=true and identical original body/eventId; no duplicate receipt/effect. Manual republish is separate. | 005/006/007; SC-003/004 |
| Pinned cross-service E2E | Register→outbox→new projection; both first-DOB routes; admin correction; broker outage/recovery; restage stored revision; initial-DOB legacy effect once, facts/corrections/replay zero financial effects. | all; SC-001…006 |
| Existing regressions/builds | Unit/PG/RMQ/transport/build/lint; keep deduct/refund/GOLD/profile/intents/outbox assertions. | 010; SC-005 |

Reuse current RMQ worker/PG fixtures first. Existing harness has no proven post-commit/pre-ACK barrier for this contract: implement a minimal **test-only** ACK wrapper/real connection closure in A or leave this gate BLOCKED. No production ACK override. Preserve message properties. Broker-down source recovery and consumer lost ACK are distinct tests.

**Before commit:** relevant unit plus full required backend Release build/tests; focused PG/migration checks; L frozen install/codegen only when needed, `bun run test --runInBand`, `bun run test:integration`, `bun run test:rmq`, `bun run build`, `bun run lint`; both `git diff --check`. Backend uses repo tooling and verified disposable CINEMA_TEST_POSTGRES_CONNECTION, Redis/RMQ. Migrations only on that verified isolated test target. No proto change planned.

**After separately authorized commits:** final A+B SHA pair, clean worktrees; sequential B `LOYALTY_REPO=<pinned L> bun tests/checkout-e2e/run.mjs`, then L `MONOLITH_REPO=<pinned B> bun run test:transports`, and new focused customer-facts E2E through that harness. Record commands/exits/skips/mock-payment boundary/redelivery evidence/cleanup. Current Jest root-wide regex can discover retained .tmp worktrees: use a dedicated clean external checkout, preserve existing .tmp files; do not weaken assertions or call nonzero aggregate run passed. Pre-commit checks do not replace committed-pair gates.

## Risks and scope boundaries

- Facts projection is not complete H-8 pre-charge evidence, personal years or eligibility. Do not expose unknown as verified ineligible later.
- Two receipt/projection models and bounded recovery are justified by already-ACKed out-of-order work, not speculative infrastructure.
- Missing/contradictory source history blocks projection visibly; do not skip or infer. Retained source audit enables investigation.
- Proposed endpoint/DTO is part of this design's implementation approval; no new business thresholds or H decisions are introduced.
- No auth/refresh-token refactor, historical data conversion, reward/tier rules, new infrastructure/dependencies or PR 1 reimplementation.
- No unresolved business contradiction found. Implementation authorization, consumer-first coordination, test-only ACK instrumentation and clean final SHA-pair verification remain gates.
