# Distributed reliability contract

This document captures invariants and review questions, not a claim that every invariant has already been implemented. Validate against the current working tree before asserting compliance.

## Service flow

- The .NET cinema platform calls loyalty gRPC endpoints and produces RabbitMQ business events.
- `TicketPurchasedConsumer` validates inbound events and delegates purchase handling to `LoyaltyService`.
- PostgreSQL holds loyalty profiles, ledger, processed event records, achievement progress, and the existing tier outbox.
- Redis/BullMQ transports background jobs. `AchievementsProcessor` modifies progress/rewards in PostgreSQL.
- Purchase/VIP transactions save `AchievementDispatchIntent` rows atomically; `AchievementIntentPublisher` retries BullMQ delivery. RabbitMQ tier outbox has a separate claim/lease/token recovery mechanism. Their retry and ownership guarantees differ; see `docs/achievement-delivery.md` and README.

## Non-negotiable invariants

1. **Commit and intent:** if a durable downstream action is required after a business commit, record its dispatch intent in the same DB transaction. Never put an external enqueue operation in a transaction retry callback.
2. **At least once:** a sender may retry after the receiving broker committed a message but the sender did not receive confirmation. Duplicate deliveries are normal.
3. **Idempotent consumer:** the same event must not create extra points, progress, ledger rows, or unlock rewards. Persistent uniqueness/dedupe must be coupled transactionally with business effects.
4. **Concurrency:** simultaneous changes to one user's balance/tier must use the established profile lock and re-read current values under lock.
5. **Claim ownership:** multiple publisher instances must not claim the same pending row at the same time. Use atomic update/compare-and-set or batch `FOR UPDATE SKIP LOCKED` plus a recoverable lease and fencing.
6. **Crash recovery:** a PROCESSING or leased event can be reclaimed after the worker dies; stale workers cannot overwrite newer attempts.
7. **Retry classes:** transient errors retry with bounded backoff and jitter; invalid payloads and other permanent failures become visible for investigation/replay.
8. **Finite resources:** bounded concurrency, batch size, connections, memory, deadlines, and predictable shutdown.
9. **Broker timeout ambiguity:** `Promise.race()` does not cancel the underlying operation. BullMQ `jobId` reduces duplicates only while that job exists; DB idempotency remains essential.
10. **Observability:** record intent age, backlog, delivery failures, attempts, stuck leases, dead-letter counts, and correlation identifiers without leaking personal data.

## Required regression scenarios

- Purchase DB transaction succeeds while Redis cannot accept a job.
- Broker accepts a job but acknowledgement times out; sender retries.
- Two application instances attempt to claim one intent concurrently.
- Owner crashes with a claimed intent; lease expires, another worker recovers.
- Old owner wakes after a newer lease was claimed; its update is rejected by fencing.
- Malformed/poison event is quarantined; transient outage retries according to policy.
- Replayed purchase/event cannot double award points or achievement rewards.
- Outbox status update fails after broker accepted the job.
- PostgreSQL transaction rollback leaves no ledger/dedupe/intent partial side effects.

Use real PostgreSQL integration tests for locking, lease/claim, and transactional behavior. Mock broker adapters if appropriate but make timeout and late completion behavior explicit.

## Operational questions

Document exactly what is acknowledged: queued, processed, or published to external consumers. Define repair/replay permissions and how operator detects dropped/stuck events. Never promise exactly-once cross-system execution.

## Inbound purchase and DOB delivery

`inbound_deliveries` is the PostgreSQL attempt journal and durable quarantine; it is not the outgoing RabbitMQ outbox. No queue redeclaration, DLX policy or queue-type change is required. Original messages remain unacknowledged until either the business callback commits successfully or the full original envelope and AMQP properties have been saved in quarantine. Extra monolith metadata remains accepted, but is never included in consumer diagnostics.

- An exact body and source queue identify one transport delivery budget (SHA-256). Business purchase deduplication still uses the existing event ID under the profile lock. Re-serializing an envelope changes the transport hash, not the business event ID.
- DOB is a setter with optional event identifiers: after a successful cycle, a new delivery of the same body can run again (A → B → A remains supported). Only successful DOB cycles may start a new budget; failures/exhaustion never reset on restart or ordinary redelivery. Birthday grants still use persistent domain deduplication. This does not impose new ordering guarantees on DOB events.
- Attempts are admitted atomically before execution and survive restarts. A crash consumes an attempt. PostgreSQL time governs the lease, backoff and fencing. A late owner cannot overwrite a newer attempt's state. A known successful business commit permits ACK even if the transport lease expired; the business dedupe handles duplicate concurrent callbacks.
- Invalid DTO/domain input and nonrepresentable integer accounting values are permanent. Recognized transient infrastructure errors and unknown failures retry within the same finite budget. No monetary cap, clamping or rounding of an overflowing total is introduced.
- Default settings: `RMQ_MAX_ATTEMPTS=3`, `RMQ_PREFETCH=5`, `RMQ_RETRY_BASE_MS=1000`, `RMQ_RETRY_MAX_MS=30000`, `RMQ_DELIVERY_LEASE_MS=30000`. Backoff doubles to the cap. The configured maximum attempts is captured on first admission; changing configuration does not reset existing budgets.
- While PostgreSQL/quarantine is unavailable, the original remains unacked and the handler pauses with bounded exponential backoff. Finite prefetch applies backpressure; this deliberately reduces throughput during an outage instead of dropping or rapidly requeueing financial events. Process/channel shutdown returns unacked messages to RabbitMQ. There is no dependency on a broker delivery counter.
- Quarantine is terminal until operator replay. Monitor `quarantine_required`, `quarantined_at`, attempts, age and `DELIVERY_STORE_UNAVAILABLE` diagnostics. Terminal rows and completed hashes are retained; automatic retention/deletion is not implemented. Plan growth/retention explicitly without deleting unresolved attempt budgets.
- Quarantine bytes can contain personal data. Restrict database/tool access, backup access and retention. Logs contain only allowlisted IDs, operation, delivery hash, static error code and attempt; they are not a copy of the payload.

### Rollout and controlled replay

1. Stop **all old source consumers** before enabling the new policy; old instances still nack/requeue without this budget. Keep the existing durable source queue and policies intact. No production broker type, policy, TLS, ACL or durability configuration is inferred from local tests.
2. Apply additive migration `20261021010000_inbound_delivery_budget` with `bun x prisma migrate deploy`, generate/build, then start only upgraded instances. The migration creates a new table and index; it does not scan existing financial tables or replay old data. Unacked messages redeliver normally. Verify actual prefetch, queue durability and effective policies in the target environment.
3. Investigate a quarantined row using restricted database access. Correct the underlying code/configuration/domain cause before replay. Do not edit its original body, financial ledger, event ID or dedupe rows. Invalid input requiring a corrected event must be reconciled with its producer rather than silently rewritten by this tool.
4. Stop **all consumers of the source queue**, including autoscaling/restarts, and keep them stopped throughout replay. The CLI checks consumer count twice, but this is an operational precondition, not a distributed deployment lock.
5. From the deployed **Node.js 22** build and service configuration, run:

   ```sh
   node dist/tools/replay-quarantine.js --delivery-id <sha256> --replay-id <new-uuid> --consumers-stopped
   ```

   Keep that replay UUID. A new UUID permits one explicitly approved budget reset. If publication fails or its result is ambiguous, rerun with the **same UUID**: it republishes without resetting the budget again. The original stored bytes remain available. Do not introduce another UUID just to bypass exhaustion.
6. Publication is persistent, mandatory and publisher-confirmed; returned/unroutable messages fail even if confirmed. A timeout does not prove absence of delivery. Consumer restart is safe only after confirming/repairing the replay publication. The original envelope and event ID are unchanged; AMQP user ID and expiration are retained as `x-loyalty-original-*` metadata rather than impersonating a broker user or expiring a financial replay. Other supported message properties are preserved. V8 property blobs are service-generated; use the deployed Node runtime, never untrusted files.
7. Resume upgraded consumers and verify business dedupe, terminal state and backlog. A crash between confirmed publish and operator confirmation can duplicate delivery; the model remains **at least once**. Quarantined messages never loop back automatically.

`bun run test:rmq` uses disposable, resource-limited PostgreSQL and RabbitMQ with real delivery/ACK/redelivery and separate worker processes. It requires Docker but no monolith checkout. `bun run test:transports` separately checks the unchanged monolith envelope and checkout integration against a pinned backend checkout.

### Passive authoritative customer facts

CUSTOMER_FACTS_CHANGED is an additive, facts-only pattern on the existing inbound
queue. Deploy its reader to **all** consumer replicas before backend PR B emits it.
The additive 20261024010000_passive_customer_facts migration creates only new
receipt/projection tables. It does not backfill registration/DOB times. Generate
the Prisma client and build with the existing workflow. There is no new queue,
broker policy, reward rule or environment requirement.

Version 1 data contains explicit fields: schemaVersion=1, eventId/userId UUID,
revision (positive PostgreSQL Int), kind (Registered, DateOfBirthSet,
DateOfBirthCorrected), occurredAtUtc, registeredAtUtc, dobFirstSetAtUtc,
dateOfBirth, previousDateOfBirth and correctionOperationId. Nullable fields must
be present. Instants are canonical UTC ISO strings with milliseconds; DOB is a
real YYYY-MM-DD calendar date, including leap days. Source instants are retained,
even when delivery is delayed or the source clock is ahead. Unknown historical
times stay null. No profile-createdAt/delivery-time substitution is permitted.

Receipt history enforces eventId and (userId, revision) identity. Exact semantic
replay is harmless; changed identity/content goes to the existing durable inbound
quarantine. Unknown metadata is ignored rather than copied to facts history.
Incoming bytes/properties remain subject to the existing restricted quarantine
retention policy. DOB and private payloads are not logged.

The profile lock precedes receipt/projection writes. Both commit atomically.
This path may create an empty financial profile for locking, but never alters its
legacy birthdayDate, balance, counters, tier, GOLD reservation, ledger, grants,
processed purchases or achievement/outbox records. The existing DOB consumer
keeps its existing behavior; corrections do not activate the future economy.

A gap is durable PENDING evidence, not proof of an absent source fact. After the
missing predecessor arrives, up to 50 contiguous revisions apply in that same
transaction. The existing scheduler checks up to 50 ready users every 10 seconds;
each uses its own short profile-locked transaction. Restart/another replica resumes
from PostgreSQL without Redis or a new lease mechanism. This provides eventual
recovery, not a 10-second delivery SLA. Permanent gaps and BLOCKED predecessors
do not become actionable until their cause is resolved.

Operational diagnosis (restricted database access):
- Inspect applied_revision/source_event_id on customer_facts_projections and
  revision/state/error_code on customer_fact_receipts. Original receipts contain
  private DOB evidence: do not paste them into general logs or public tickets.
- A missing revision must be investigated at the authoritative backend audit.
  Restage the **stored** original source revision with the same eventId/content
  through its outbox (PR B). Do not invent facts, renumber or skip a revision.
- A predecessor contradiction is stored as BLOCKED with
  CUSTOMER_FACT_PREDECESSOR_MISMATCH; the last valid projection is retained.
  Fix the validated cause first. For a consumer-validation defect corrected by a
  reviewed release, re-evaluate the immutable original receipt:
  node dist/tools/recheck-customer-fact.js --recheck-blocked --event-id <uuid>.
  DATABASE_URL is the only required configuration. The operation takes the same
  profile lock, records recheck_count/rechecked_at, and changes neither source
  payload nor predecessor. Exit 0 means no longer blocked; exit 2 means still
  BLOCKED; exit 1 means failure/ambiguous result, so inspect/retry, not assume rollback.
- A genuinely contradictory producer history cannot be made valid by replaying
  it. Stop that stream's source emission, retain the original evidence and obtain
  an explicitly reviewed authoritative repair. This release deliberately has no
  payload-edit/skip/force-apply command. Recheck is not authorization to rewrite
  history or to activate birthday benefits.
- Direct identity conflicts use the existing quarantine review/replay procedure;
  unchanged replay remains a conflict until the source/consumer cause is resolved.
  No automatic quarantine replay or financial compensation is introduced.

Local bun run test:integration and bun run test:rmq cover receipt/projection
transactions, gaps, controlled overlaps, restart and real broker lost-ACK
redelivery. Cross-service registration/first-DOB/correction E2E still requires PR B
and clean pinned commits in both repositories.

### Passive session completion v1

`SESSION_COMPLETED` uses the existing inbound `RMQ_QUEUE` (normally
`loyalty_ticket_purchased`), durable declaration, manual ACK, retry budget and
restricted durable quarantine. It creates no new queue or broker policy.
The raw JSON envelope is `{ "pattern": "SESSION_COMPLETED", "data": { ... } }`.
Required data: `schemaVersion: 1`, canonical UUID `eventId` and `sessionId`,
`revision: 1`, and a real canonical UTC `completedAtUtc` string with exactly six
fractional digits. Years 0001–9999 are accepted. There is no user/order identity.

Migration `20261029010000_passive_session_completion` creates one independent
`session_completion_facts` table. It retains all canonical fact fields and the
first receipt time. PostgreSQL enforces event identity and unique
`(sessionId, revision)`. The service inserts or reads facts; it never updates a
previously accepted fact. Semantic duplicates (including key order/UUID case)
are successful no-ops. Reusing either identity with changed canonical content,
including a different eventId for the same session/revision, is a permanent
`SESSION_COMPLETION_IDENTITY_CONFLICT`. Invalid or future-version/revision input
is `INVALID_SESSION_COMPLETION`. Both use the existing quarantine flow; original
evidence remains intact. Unknown metadata is stripped from the business fact.

`completedAtUtc` stays VARCHAR text: PostgreSQL microseconds must not be rounded
through JavaScript Date when storing or comparing facts. `receivedAt` is local
transport metadata, never a substitute for completion time. The receipt is also
the minimal v1 completion projection; no mutable projection, revision-gap
scheduler, profile relation or purchase projection is introduced. Completion can
arrive before purchases. Ingestion does not create LoyaltyProfile or change
balance, ledger, dedupe records for purchases, tier, GOLD, birthday grants,
achievements or outbox/intents. Current purchase reward behavior is unchanged.

Deploy this additive schema and the reader to **all** replicas before the backend
emits the new pattern. Backend completion/worker/source snapshot is a separate
PR. Its replay must retain the original eventId/content. Quarantine replay uses
the existing reviewed procedure; republishing a changed payload under an existing
identity cannot repair a conflict. This release supports neither corrections nor
revision > 1. Coordinate future producer/consumer upgrades before enabling them.

Fixed cross-language fixtures are in `test/fixtures/session-completed-v1.json`.
Verify the proposed BCL-only .NET serializer without rewriting fixtures:

```powershell
dotnet run --project test/fixtures/session-completed-dotnet/SessionCompletedFixtures.csproj --artifacts-path .tmp/session-completed-dotnet -- test/fixtures/session-completed-v1.json
```

The optional fixture check requires .NET 10; the service runtime remains Node.js
22 with Bun 1.3.13/Jest. Unit tests validate the fixed fixtures with the actual
Zod DTO. `bun run test:integration` covers real PostgreSQL identity races,
rollback, precise timestamps and zero financial effects. `bun run test:rmq`
starts real Nest RMQ microservices against disposable PostgreSQL/RabbitMQ,
covering the fixed envelopes, two replicas, quarantine, DB retry and a killed
consumer after business commit before ACK, with broker redelivery evidence.
