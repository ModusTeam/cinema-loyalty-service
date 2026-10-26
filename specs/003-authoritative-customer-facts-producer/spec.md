# Feature Specification: Authoritative Customer Facts Producer

**Change**: `003-authoritative-customer-facts-producer` — Stage 1 / PR 2B
**Created**: 2026-10-26
**Status**: Draft for user review; planning only, implementation not authorized.
**Target**: Cinema Platform Backend. Loyalty is the SDD root and existing passive consumer.
**Related change**: [002 / PR 2A](../002-authoritative-customer-facts/spec.md); those artifacts are preserved, not replaced.

## Problem statement and scope

Future personal loyalty years and birthday eligibility need truthful registration and first-DOB instants. The backend currently stores a DOB but neither timestamp, retained customer-fact identity nor revision history. A later message handler cannot reconstruct these facts from delivery time or LoyaltyProfile.createdAt.

PR 2B establishes reliable source facts for registration and first DOB through every existing production entry point. It provides the revision/audit foundation for controlled corrections and exact restaging without adding a public correction API. The already merged reader remains passive. This change does not activate the future economy.

Sources: [master B.3, B.4, D.7, E, F Stage 1, H-3/H-5/H-8/H-11](../../docs/loyalty-economy-architecture-spec.md), [constitution](../../.specify/memory/constitution.md). H-1…H-16 remain approved. Detailed evidence and the fixed reader contract are in [plan.md](plan.md).

## User Scenarios & Testing

### User Story 1 — Truthful registration (Priority: P1)

A successfully created account has one authoritative registration instant and a recoverably deliverable registration fact, regardless of broker availability.

**Independent test**: Register through real Identity persistence, inspect user/role/fact/outbox in a new scope, then repeat/race registration and inject role or persistence failure.

1. Given a new valid registration, when it succeeds, then the account, required role and exactly one registration fact are committed together.
2. Given a rejected account creation, role assignment or fact staging, when the operation ends, then none of that operation's account/role/fact/delivery changes is committed.
3. Given a committed registration whose response is lost, when registration is repeated, then existing API duplicate-account behavior may reject the request, but no second account or registration fact is created. This PR does not introduce a new HTTP idempotency key.
4. Given an existing account without reliable historical registration evidence, when migrated or updated, then its registration time stays unknown.
5. Given an enabled admin seeder creating a new account, when it succeeds, then it follows the same truthful account/fact rule; finding an existing account does not manufacture a new registration.

### User Story 2 — First DOB across existing routes (Priority: P1)

A customer's first successful DOB declaration has a stable first-set instant and one source revision. Different self-service routes cannot independently establish different first values.

**Independent test**: Exercise both DOB command handlers and their HTTP aliases, including controlled overlapping requests and UpdateProfile calls that omit DOB.

1. Given no DOB, when either existing handler accepts a date, then the declared calendar date, first-set instant, next customer revision and corresponding delivery records commit atomically.
2. Given an already set DOB, when the set-once command repeats, then its existing conflict behavior remains; UpdateProfile with the same date keeps its existing success behavior without a new customer revision or first-set event.
3. Given a stored DOB, when UpdateProfile omits DOB, then it retains the date and timestamps; a different self-service date is refused. Clearing is not introduced.
4. Given two overlapping first-DOB requests, when they complete, then at most one first-set revision exists and no message describes a losing value.
5. Given a legacy user with no DOB, when a first declaration actually succeeds now, then first-set time is now authoritative while registration stays null. Given a legacy DOB already present, do not invent its first-set time.

### User Story 3 — Durable delivery, audit and controlled recovery (Priority: P1)

Committed facts remain recoverable across broker failure, process failure, duplicates and reordered delivery. Support can inspect source history without rewriting accepted evidence.

**Independent test**: Stop broker delivery, commit facts, restart producer delivery, capture original events, redeliver/restage and compare the passive consumer's history/projection and financial state.

1. Given committed source state and unavailable RabbitMQ, when delivery resumes after restart, then the original identity, revision, facts and business instants are delivered.
2. Given a transaction rollback, then no publishable fact from that operation remains.
3. Given a missing revision, when the stored source revision is explicitly restaged, then its original identity/content is reused; no new source revision is allocated.
4. Given duplicate or out-of-order delivery, then exact facts deduplicate or wait for predecessors; changed content under the same identity is diagnosed rather than accepted as a new truth.
5. Given a controlled internal DOB correction, then it requires actor, reason, expected revision and operation identity; old/new date and historical result are retained. Exact replay returns that result, even after later changes. No public correction/clear route is added by this PR.
6. Given passive facts and the retained initial-DOB legacy event, then new facts alone produce no reward/tier effect; the legacy flow retains its existing business effect and grant dedupe.

### Edge cases

UTC/Kyiv midnight, leap dates, sub-millisecond .NET precision, unknown legacy evidence, same-date retries, A→B→A corrections, revision exhaustion, stale Identity tracking, role/password mutations racing DOB, failure after intermediate Identity SaveChanges, ambiguous commit acknowledgement, broker outage and lost consumer ACK.

## Functional requirements

- **FR-001**: Persist an immutable server-owned registration instant for newly committed accounts, including executable seed paths. Do not assign a historical instant to previously existing accounts.
- **FR-002**: Persist first-DOB time once for an actual first declaration across both handlers; preserve the declared calendar date, current validations and existing public response semantics.
- **FR-003**: Retain a per-user positive contiguous source revision and globally unique event identity for each accepted fact. Retries and reconstruction from committed history must preserve their contents.
- **FR-004**: Commit account/required-role changes, source head/history and all related new/legacy delivery records as one local operation. Failed operations cannot leave publishable success facts.
- **FR-005**: Deliver `CUSTOMER_FACTS_CHANGED` version 1 exactly as accepted by merged PR 2A, with explicit nulls, UTC millisecond instants, calendar-only DOB and stable UUIDs. Do not alter loyalty production code or proto.
- **FR-006**: Use the existing durable outbox. Broker outage/crash does not lose committed facts; no direct network publication substitutes for the transaction.
- **FR-007**: Serialize same-user facts writers and guard revision/event uniqueness in persistence. A concurrent losing command cannot publish its uncommitted DOB. Ordinary Identity updates must not overwrite newer facts metadata.
- **FR-008**: Keep restricted immutable source snapshots sufficient for recovery after transport records are delivered/removed. Provide narrowly controlled restaging by stored event identity; never rebuild business timestamps from current time.
- **FR-009**: Model controlled corrections with previous/new DOB, original first-set time, authenticated/explicitly authorized actor, reason, expected revision, stable correction operation identity and historical result. Reject identity reuse with changed actor/content; no new public correction API, clearing or financial correction is in scope.
- **FR-010**: Preserve `USER_DATE_OF_BIRTH_SET` on an accepted first DOB and the existing `UserProfileUpdatedMessage` paths. Stage old/new messages from the same accepted source state; no first-set legacy bonus message on registration, correction or restaging the passive fact.
- **FR-011**: Distinguish source occurrence from publication/receipt. Registration anniversary and birthday calendar calculations remain later stages; unknown facts are not proven ineligibility.
- **FR-012**: Treat commit acknowledgement loss as ambiguous. Do not blindly rerun a multi-save operation or report proven rollback; inspect committed source state from a fresh scope. Do not log DOB, email, reason, credentials, raw envelopes or private exception payloads.
- **FR-013**: Deploy all passive readers before enabling producer emissions. Old competing readers on the shared queue must not consume an unsupported pattern.

## Business invariants and traceability

| Requirement | Master authority | PR 2B interpretation |
| --- | --- | --- |
| FR-001/002/011 | B.3/B.4, H-3/H-5/H-8, I-14/I-19 | Truthful source evidence; personal-year/birthday eligibility itself is not implemented |
| FR-003/005/007/008 | F Stage 1, I-06/I-14, constitution III/VI | Stable identity/revisions; delivery never invents source time |
| FR-004/006/012 | I-25/I-26, constitution II–V | Local source/history/outbox atomicity, no external work in retried DB callbacks |
| FR-009/010 | B.4, H-11, I-22 | Accountable corrections, no new birthday entitlement or accounting effect |
| FR-005/006/013 | I-28, constitution IV/VI | Existing consumer commit/quarantine-before-ACK is preserved, not reimplemented |

## Cross-service contract and compatibility requirements

The canonical v1 matrix in plan.md is normative for the producer. The envelope uses `pattern: CUSTOMER_FACTS_CHANGED` and `data`, not MassTransit's standard message wrapper. Every nullable data property must be present. This PR changes neither gRPC nor existing queue names. `USER_DATE_OF_BIRTH_SET` and `user.profile_updated` remain on their existing destinations.

New facts and legacy DOB are distinct compatibility messages, not two competing financial writers. The new consumer is passive and does not update legacy birthdayDate, balance, ledger, counters, achievements, tier or GOLD. Their relative arrival order must not be required for current benefits or contiguous facts recovery.

## Error and recovery behavior

Rejected input/Identity/concurrency failures return existing Result-based failures, with safe new static error codes only where necessary. Pre-commit failure rolls back the whole operation. Ambiguous commit is investigated, not labeled rollback. Retained history supports exact restaging; missing predecessor is not silently skipped. Conflicting facts remain quarantined/BLOCKED under PR 2A policy and require diagnosis, never automatic identity replacement.

## Acceptance criteria / Success Criteria

| ID | Testable exit condition | Requirements |
| --- | --- | --- |
| AC-01 | Fresh registration and each enabled new-admin seed commit one user, intended role, registration revision and outbox fact; failures at create/role/stage/save commit none | FR-001/003/004/006 |
| AC-02 | Both DOB handlers and their aliases preserve validations/statuses; exactly one first-set fact under overlap; omitted/same DOB does not create another revision | FR-002/007/010 |
| AC-03 | Reload in a new scope produces the same eventId, revision, all UTC strings, dates and explicit nulls; serialized outbox retry and stored-history restage are verified separately | FR-003/005/008/011 |
| AC-04 | DB failures before commit leave user/head/history/outbox unchanged; with production retry configuration the transaction is valid; unknown commit does not trigger duplicate writes | FR-004/007/012 |
| AC-05 | Real broker outage/restart eventually delivers the same committed fact; manual duplicate and real lost-ACK redelivery are independently evidenced | FR-005/006/008 |
| AC-06 | Legacy accounts preserve unknown timestamps and existing DOB; no fabricated registration or bulk replay; new first-DOB root is accepted by unchanged reader | FR-001/002/005/011 |
| AC-07 | Controlled internal correction enforces revision/operation identity and audit, preserves first-set time, rejects clear/no-op/conflict; exact replay returns its historical result | FR-007/009 |
| AC-08 | Pinned cross-service registration and first-DOB reach contiguous projection; duplicates/order gaps/conflicts follow PR 2A behavior; financial invariants unchanged except retained legacy first-DOB effect | FR-005/010/013 |
| AC-09 | All source creation/DOB write paths are accounted for, tests/checks documented with actual commands/exits, restricted logs verified and consumer-first rollout documented | FR-001…013 |

## Dependencies, exclusions and approval

Requires merged PR 2A (`5ae3ad1` baseline) and existing backend payment-facts/outbox baseline (`f5bb441`). Actual implementation bases must be rechecked. New schema precedes producer; all source writers upgrade together before new mutations are admitted. No automatic rollback to old DOB writers after facts emission.

Excluded: birthday gifts/multipliers/reservations, tiers/personal-year calculation, FEFO/debt, session/refund lifecycle, payment PR 1 reimplementation, auth/role redesign, new services/frameworks/dependencies, public correction API, clear-DOB event, historical backfill, production changes. Database resets are not authorized.

No unresolved business decision blocks registration/first-set implementation. Internal correction/replay entry points and transaction mechanism are proposed engineering design subject to this plan's review; support UI/public API and new calendar-policy activation remain separate work. No tests were executed during planning.
