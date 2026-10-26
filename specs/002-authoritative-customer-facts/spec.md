# Feature Specification: Authoritative customer registration and DOB facts

**Feature**: `002-authoritative-customer-facts` — Stage 1 / PR 2 (coordinated repository pair)
**Created**: 2026-10-23
**Status**: Proposed implementation-ready plan; implementation requires separate approval
**Feature Branch**: None created; feature selection is independent of Git branch.
**Input**: Persist authoritative customer registration/first-DOB timestamps, revisioned corrections and reliable fact ingestion without activating the new loyalty economy.

## Context and authoritative sources

Business authority: [master specification](../../docs/loyalty-economy-architecture-spec.md), B.3, B.4, F Stage 1, H-3/H-5/H-8/H-11. Engineering authority: [constitution](../../.specify/memory/constitution.md). H-1…H-16 remain approved; this change does not reopen them. Stage 1 / PR 1 is merged in backend PR #80 and is a prerequisite, not work to repeat.

Backend owns account facts. Loyalty holds a derived, revisioned history/projection. Customer registration is not loyalty-profile creation; first DOB declaration is not message delivery or a later correction. Financial interpretation of corrections belongs to the dependent birthday/tier stages.

## User Scenarios & Testing

### User Story 1 — Preserve truthful account history (Priority: P1)

A registered customer has one stable registration instant and, after their first DOB declaration, one stable first-declaration instant. These facts survive delayed delivery and reloads.

**Independent Test**: Register, commit, set DOB through each supported self-service route, reload in a new scope, reconstruct messages and compare identities, calendar date and timestamps.

**Acceptance Scenarios**:

1. **Given** a new registration, **when** registration succeeds, **then** one registration fact is persisted and recoverably deliverable with the same user identity and timestamp.
2. **Given** no DOB, **when** either supported self-service route sets it, **then** its calendar date and first-set instant are persisted once; another self-service change cannot reset them.
3. **Given** two concurrent first-DOB commands, **when** they overlap, **then** at most one accepted first-set revision exists and no event describes a losing value.
4. **Given** an existing account with unknown historical timestamps, **when** this feature is installed or a correction occurs, **then** unknown timestamps remain explicitly unknown; neither profile creation nor the current time becomes historical registration/first-set time.

### User Story 2 — Correct DOB through accountable support (Priority: P1)

An authorized administrator can correct a recorded DOB using a reason and stable operation identity. Customers cannot bypass set-once behavior through this route.

**Independent Test**: Submit an authorized correction, replay it after another correction, race two expected-revision updates, and inspect immutable audit and delivery records.

**Acceptance Scenarios**:

1. **Given** a recorded DOB and current revision, **when** an authorized correction is accepted, **then** previous/new date, authenticated actor, reason, operation identity and correction time are auditable together with the next fact revision.
2. **Given** a successful correction whose response was lost, **when** its exact command is repeated, **then** its historical result is returned without another revision; a different request using that identity is rejected.
3. **Given** a stale expected revision or an unauthorized actor, **when** correction is attempted, **then** no account, audit or deliverable fact changes.
4. **Given** earlier benefits or a frozen payment snapshot, **when** DOB is corrected, **then** this facts-only change grants no points, creates no anniversary entitlement and rewrites no snapshot. Future birthday interpretation must retain B.4's correction restrictions.

### User Story 3 — Recover customer facts without rewriting history (Priority: P1)

Loyalty receives facts once or repeatedly, in any order, and retains the source history without replacing a newer accepted state with an older state.

**Independent Test**: Deliver revisions 3, 1, 2 over RabbitMQ; crash after a receipt/commit and before ACK; restart with the same database and inspect the projection and original financial state.

**Acceptance Scenarios**:

1. **Given** repeated identical facts, **when** processed concurrently or after restart, **then** one receipt per source revision exists and no second business effect occurs.
2. **Given** revision 3 before 1/2, **when** it is received, **then** it is durably pending; missing evidence is visible, not silently treated as known history. Arrival of the gap closes the chain and advances the projection monotonically.
3. **Given** a reused event identity/revision with conflicting contents, **when** received, **then** accepted facts are retained and the conflict is durably rejected for investigation rather than endlessly retried.
4. **Given** a failure before producer or consumer commit, **when** retried, **then** there is no partial account/audit/outbox or receipt/projection change.
5. **Given** a committed fact and unavailable broker/consumer, **when** transport recovers, **then** the same original fact can be delivered; delivery time does not replace business time.

### Edge Cases

- Registration near Europe/Kyiv midnight; DST changes; leap-day DOB/registration; invalid calendar dates.
- First DOB through UpdateProfile as well as SetMyDateOfBirth; self-service same-date replay preserves current response semantics.
- Registration failure after Identity's first SaveChanges; role-assignment failure; outbox staging failure; ambiguous commit acknowledgement.
- Correction before registration fact arrives, a missing revision that never arrives, and a conflicting predecessor discovered after a pending receipt was ACKed.
- A correction restores an earlier DOB value (A → B → A): each accepted operation is a distinct revision; it never creates a fresh first-set time.
- Legacy DOB messages contain no reliable revision. They must not be promoted into authoritative customer history.

## Requirements

### Functional Requirements

- **FR-001**: Persist a server-owned registration instant once for every newly successful customer registration; ordinary updates and delivery cannot change it.
- **FR-002**: Persist the first successful self-service DOB-set instant once across both existing write routes. Preserve the declared calendar date and set-once behavior; corrections never restart this clock.
- **FR-003**: Give each customer's fact stream a stable customer identity, strictly increasing positive revision, distinct persisted event identity and explicit contract version. Retries/reconstruction preserve those values and contents.
- **FR-004**: Allow controlled DOB correction only through the existing administrative authorization model, with authenticated actor, nonempty reason, expected revision and persistent operation identity. Exact replay returns its historical result; identity reuse with different content is refused.
- **FR-005**: Atomically persist each accepted source change, its audit/revision and reliable delivery record. On the receiving side, atomically persist its receipt, any accepted projection change and recovery state under the existing profile-lock discipline.
- **FR-006**: Deliver through the existing reliable messaging mechanism with unchanged original business facts across retries and restarts. A financial/identity failure must not be silently acknowledged before commit or durable rejection.
- **FR-007**: Deduplicate by semantic source identity/revision, not message bytes or transient job identity. Reject conflicting identity/content even for an older already recorded revision.
- **FR-008**: Persist out-of-order revisions without regressing the accepted projection. Do not apply a revision across an unresolved predecessor gap; make incomplete or contradictory history explicit.
- **FR-009**: Distinguish source occurrence time from receipt/application time. DOB is a calendar date; factual instants are UTC. Preserve enough information for later Europe/Kyiv H-3/H-5 calculations without activating those calculations here.
- **FR-010**: Keep registration/correction ingestion financially passive. Preserve the current initial-DOB legacy flow, its delivery safeguards and existing grant dedupe. Do not activate new birthday eligibility, tier periods, corrections of financial entitlements or any other new economy.
- **FR-011**: Do not fabricate missing historical timestamps. Old accounts/DOBs remain explicitly unknown unless a future separately authorized process has authoritative evidence; no backfill from profile creation, deployment time or message receipt.
- **FR-012**: Validate the new fact contract and correction request, retain restricted audit evidence, and log only allowlisted identifiers/error codes. Do not expose DOB or support reasons through raw payload/exception logging.
- **FR-013**: Recover durably pending, now-applicable revisions after process failure, even if their broker messages were already ACKed. Permanent gaps/conflicts remain visible for controlled investigation/replay and do not cause a hot retry loop.

### Key Entities

- **Authoritative customer**: Stable user identity, registration instant, first-DOB instant, current DOB and fact revision.
- **Customer fact revision**: Immutable account snapshot/change identity and source occurrence time; correction records also link the previous date and authorized operation.
- **Correction audit**: Actor, reason, old/new date and historical result associated with one accepted operation.
- **Loyalty customer projection and receipt history**: Derived contiguous accepted state plus durable pending/blocked source revisions; neither is reward accounting or proof of complete historical eligibility by itself.

### Traceability to master

| Requirements | Master authority / invariants |
| --- | --- |
| FR-001/002/009/011 | B.3 registration anchor, B.4 account/DOB age; H-3/H-5/H-8; I-14/I-19 |
| FR-003/005/006/007/008/013 | F Stage 1; I-06/I-14/I-25/I-26/I-28; constitution II–VI |
| FR-004/010/012 | B.4 controlled corrections and anniversary restrictions; H-11; I-22, with financial application deferred |

I-19/I-22 are enabled by truthful evidence here, not fully implemented: no eligibility guarantee, anniversary budget or retroactive financial correction is claimed by this change.

## Success Criteria

- **SC-001**: Every successful new registration and first DOB declaration has exactly one truthful, stable source instant; rejected/repeated changes cannot replace it.
- **SC-002**: Every accepted correction has one inspectable audit/revision and an exact-repeat historical result; losing or conflicting requests have zero persisted effect.
- **SC-003**: All specified duplicate, conflicting and reordered delivery cases preserve the accepted history; missing revisions cannot masquerade as complete evidence.
- **SC-004**: Injected failures yield either the complete local mutation or none, and committed pending work remains recoverable after restart.
- **SC-005**: New customer facts alone change zero financial balances, ledgers, tier grants, GOLD reservations or achievement entitlements; existing initial-DOB behavior remains covered separately.
- **SC-006**: Future calendar calculations can recover the same registration/DOB dates and source instants regardless of delivery delay, server timezone or persistence reload.

## Assumptions, exclusions and approval

- University/development data are disposable; historical conversion, dual economy and automatic database reset are unnecessary. Reset is not authorized.
- Registration API shape and its existing duplicate-email behavior are retained; this is not an auth/idempotency redesign. Registration request replay need not return a new success response, but it must not create another user/fact.
- Support uses the existing Admin role. This change proposes a narrow correction operation, not support UI or new permission infrastructure.
- B.4's effective-anniversary rule remains mandatory for Stage 6. Persisting a corrected DOB now does not claim birthday entitlement effects are activated in the current economy.
- Excluded: PR 1 reimplementation; birthday multiplier/gift/reservations; personal-year/tier calculation; reward accounting/FEFO/debt; payment/session/refund redesign; unrelated Identity refactoring; new infrastructure.
- This specification and its linked plan/tasks are proposals for explicit implementation approval. No tests, implementation, migration application, Git publication or deployment are authorized by planning.
