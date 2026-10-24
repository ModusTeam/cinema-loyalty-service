# Cinema Loyalty Service

<p align="center">
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-7-2D3748?style=for-the-badge&logo=prisma&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-Database-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" />
  <img alt="Redis" src="https://img.shields.io/badge/Redis-BullMQ-DC382D?style=for-the-badge&logo=redis&logoColor=white" />
  <img alt="RabbitMQ" src="https://img.shields.io/badge/RabbitMQ-Events-FF6600?style=for-the-badge&logo=rabbitmq&logoColor=white" />
  <img alt="gRPC" src="https://img.shields.io/badge/gRPC-Protobuf-244C5A?style=for-the-badge&logo=google&logoColor=white" />
</p>

<p align="center">
  Loyalty, achievements, points economy, GOLD seat upgrades, birthday bonuses, gRPC APIs, RabbitMQ consumers, and BullMQ background jobs for the Cinema Platform.
</p>

## Table Of Contents

- [Overview](#overview)
- [Core Capabilities](#core-capabilities)
- [Technology Matrix](#technology-matrix)
- [Architecture](#architecture)
- [Business Rules](#business-rules)
- [gRPC API](#grpc-api)
- [RabbitMQ Events](#rabbitmq-events)
- [BullMQ Jobs](#bullmq-jobs)
- [Project Structure](#project-structure)
- [Local Setup](#local-setup)
- [Scripts](#scripts)
- [Useful SQL Checks](#useful-sql-checks)
- [Troubleshooting](#troubleshooting)

## Overview

Cinema Loyalty Service is a NestJS microservice responsible for the loyalty domain in the Cinema Platform. It exposes internal gRPC APIs for the .NET monolith, consumes RabbitMQ events from the checkout flow, persists loyalty state in PostgreSQL, and runs scheduled or asynchronous workloads through BullMQ.

| Area | Responsibility |
| --- | --- |
| Loyalty profiles | Balance, lifetime points, yearly points, yearly visits, user tier |
| Points economy | Earn, deduct, refund, expire, adjust, and audit point transactions |
| Discount preview | Calculate how many points can be applied before checkout |
| GOLD benefits | One GOLD seat upgrade per user per month |
| Birthday rewards | One birthday bonus per UTC calendar year |
| Achievements | Criteria-based progress, unlocks, secret achievements, reward points |
| Reliability | Transactions, idempotency keys, processed events, transactional outbox |

## Core Capabilities

| Capability | Entry Point | Storage | Notes |
| --- | --- | --- | --- |
| Get loyalty balance | gRPC `GetBalance` | `loyalty_profiles` | Creates a profile if it does not exist |
| Full profile view | gRPC `GetFullProfile` | `loyalty_profiles` | Includes tier, expiry dates, birthday week, GOLD availability |
| Discount preview | gRPC `CalculateDiscount` | `loyalty_profiles` | Used by the .NET backend before checkout |
| Deduct points | gRPC `DeductPoints` | `points_transactions`, `processed_events` | Idempotent by `idempotency_key` |
| Refund points | gRPC `RefundPoints` | `points_transactions` | Used as checkout compensation |
| Ticket purchase processing | RabbitMQ `TicketPurchased` | `loyalty_profiles`, `points_transactions` | Awards points only when points were not redeemed |
| Achievement processing | BullMQ `achievements-queue` | `achievements`, `user_achievements` | Validates payload and criteria with Zod |
| Scheduled maintenance | BullMQ `loyalty-queue` | loyalty tables | Expiry, notifications, annual reset, GOLD reset, birthday bonuses |

## Technology Matrix

| Layer | Technology | Purpose |
| --- | --- | --- |
| Runtime | Node.js 22 | JavaScript runtime |
| Package manager | Bun 1.3.13 | Dependency installation and package scripts |
| Framework | NestJS 11 | Application modules, DI, microservices |
| Language | TypeScript 5.7 | Typed service implementation |
| Database | PostgreSQL | Durable loyalty and achievement state |
| ORM | Prisma 7 | Type-safe database access and migrations |
| Synchronous API | gRPC + Protobuf | Internal API consumed by `cinema-platform-back` |
| Event transport | RabbitMQ | Ticket purchase and loyalty domain events |
| Background jobs | BullMQ + Redis | Scheduled jobs and asynchronous achievement processing |
| Validation | Zod, class-validator | Runtime payload and criteria validation |
| Tests | Jest | Unit/e2e testing |
| Proto tooling | Buf | Proto lint/build validation |

## Architecture

### Service Context

```mermaid
flowchart LR
    Platform["cinema-platform-back<br/>.NET monolith"]
    Loyalty["cinema-loyalty-service<br/>NestJS"]
    Postgres[("PostgreSQL")]
    Rabbit["RabbitMQ"]
    Redis[("Redis")]
    Workers["BullMQ workers"]

    Platform -- "gRPC: balance, discount, deduct, refund" --> Loyalty
    Platform -- "RabbitMQ: TicketPurchased" --> Rabbit
    Rabbit --> Loyalty
    Loyalty --> Postgres
    Loyalty --> Redis
    Redis --> Workers
    Workers --> Postgres
```

### Ticket Purchase Flow

```mermaid
sequenceDiagram
    participant User
    participant Platform as cinema-platform-back
    participant Loyalty as loyalty-service
    participant Rabbit as RabbitMQ
    participant DB as PostgreSQL
    participant Jobs as BullMQ

    User->>Platform: Checkout request
    Platform->>Loyalty: CalculateDiscount(userId, orderAmount)
    Loyalty-->>Platform: pointsToDeduct, amountToPay
    Platform->>Loyalty: DeductPoints(...)
    Loyalty->>DB: BURN_DISCOUNT transaction
    Platform->>Rabbit: TicketPurchased event
    Rabbit->>Loyalty: consume TicketPurchased
    Loyalty->>DB: commit visits/tier/points + achievement intents
    Note over Loyalty,DB: same transaction as purchase dedupe and ledger
    Loyalty->>Jobs: scheduled publisher enqueues persisted intents
    Jobs->>DB: update achievement progress
```

### Reliability Model

```mermaid
flowchart TD
    Event["Incoming event / gRPC command"]
    Validate["Validate DTO / schema"]
    Idempotency["Check processed_events or idempotency key"]
    Tx["Prisma transaction"]
    Outbox["outbox_events"]
    Publish["Outbox publisher -> RabbitMQ"]
    Intents["achievement_dispatch_intents"]
    Queue["Achievement intent publisher -> BullMQ"]

    Event --> Validate --> Idempotency --> Tx
    Tx --> Outbox --> Publish
    Tx --> Intents --> Queue
```

## Business Rules

### Points Earning

`TicketPurchased` may include both payment and redemption values:

```json
{
  "totalAmount": 500,
  "ticketAmount": 500,
  "paidAmount": 200,
  "pointsUsed": 300
}
```

| Condition | Result |
| --- | --- |
| `pointsUsed > 0` | No new points are awarded for this purchase |
| `pointsUsed = 0` or missing | Points are calculated from `paidAmount ?? totalAmount` |
| `pointsUsed` is missing | Service checks `BURN_DISCOUNT` transactions by `orderId` |
| Purchase already processed | Event is skipped through `processed_events` |

The visit is still counted in `yearVisits`, and achievements receive `paidAmount` and `pointsUsed` metadata.

### Discount Preview

| Rule | Value |
| --- | --- |
| Method | gRPC `CalculateDiscount` |
| Minimum deduction | `75` points |
| Maximum discount | `50%` of order amount |
| Conversion | `1 point = 1 currency unit` |
| Consumer | `.NET` monolith before checkout |

### Tier Rules

| Tier | Year Visits | Year Points | Multiplier |
| --- | ---: | ---: | ---: |
| `BRONZE` | default | default | `1.0x` |
| `SILVER` | `8+` | `2000+` | `1.5x` |
| `GOLD` | `20+` | `5000+` | `2.0x` |

### Birthday Bonus

| Rule | Value |
| --- | --- |
| Bonus amount | `100` points |
| Date logic | UTC local date semantics |
| Idempotency | unique `(userId, type, grantYear)` in `user_bonus_grants` |
| Scheduled job | `grant-birthday-bonuses` every day at `00:10 UTC` |

### GOLD Seat Upgrade

| Rule | Value |
| --- | --- |
| Eligible tier | `GOLD` |
| Limit | one active upgrade per UTC calendar month |
| Ownership | `gold_upgrade_reservations`: user, UTC month, order, release timestamp |
| Usage field | `gold_upgrade_used_month` is a compatibility/read projection |
| Reset job | Clears only older month projections; preserves current usage and reservation history |

`UseGoldUpgrade` binds an order permanently to its original month. An active reservation repeats successfully, including after a tier/month change, without consuming another quota. A released order cannot reserve again. A new order still requires GOLD. `RollbackGoldUpgrade` releases only that user's matching order, even after a tier change; repeated rollback succeeds without touching a replacement reservation. Unknown orders are rejected. Both operations lock the profile first and commit ownership and the projection atomically. UTC month is determined after acquiring the profile lock; replicas still require synchronized clocks.

#### GOLD ownership migration and rollout

1. Stop **all** old instances accepting GOLD Use/Rollback and running `gold-reset`; prevent checkout from making new reservations during the transition. Mixed old/new writers are unsafe because old code ignores ownership.
2. Apply `20261016040000_own_gold_upgrade_reservations` with `bun x prisma migrate deploy`. It creates a new table and unique indexes, then copies every non-null legacy month as an active hold with **no order owner**. Existing migrations are unchanged. Check source cardinality and migration duration on a production-sized copy; backfill reads the profile table and writes the new table, so synthetic tests do not establish a production duration bound.
3. Deploy all new RPC/job instances, then resume checkout. Do not roll back to old writers without stopping traffic and reconciling reservations first.

Legacy occupancy is never automatically assigned to the caller or released by an unknown rollback. A current-month hold returns a reconciliation-required failure; a later month's new reservation is allowed. For each disputed hold, reconcile authoritative checkout/payment/ticket records for that user and month. In a short operator transaction, lock the profile first, recheck the hold, then either bind its `order_id` to the proven original order (checking uniqueness), or mark it released and conditionally clear the same-month projection **only when evidence proves the benefit is unused/cancelled**. Uncertain holds remain occupied; no mass release or replay. Reset only removes old projections, retaining these holds and historical order bindings.

## gRPC API

Proto file: [`src/proto/loyalty/v1/loyalty.proto`](src/proto/loyalty/v1/loyalty.proto).

| Service | RPC | Purpose |
| --- | --- | --- |
| `LoyaltyService` | `GetBalance` | Get balance, lifetime points, yearly points, tier |
| `LoyaltyService` | `GetFullProfile` | Get full loyalty profile |
| `LoyaltyService` | `GetTransactions` | Get user transaction history |
| `LoyaltyService` | `CalculateDiscount` | Preview point deduction and amount to pay |
| `LoyaltyService` | `DeductPoints` | Deduct points for checkout |
| `LoyaltyService` | `RefundPoints` | Refund deducted points |
| `LoyaltyService` | `UseGoldUpgrade` | Reserve monthly GOLD upgrade |
| `LoyaltyService` | `RollbackGoldUpgrade` | Roll back GOLD upgrade reservation |
| `LoyaltyService` | `GetAdminUserBalance` | Admin balance lookup |
| `LoyaltyService` | `GetAdminTransactionHistory` | Admin transaction lookup |
| `LoyaltyService` | `ModifyUserPoints` | Admin manual points adjustment |
| `LoyaltyService` | `GetAdminUsers` | Admin loyalty users list |
| `LoyaltyService` | `GrantVipStatus` | Admin grant VIP/GOLD-like status |
| `AchievementsService` | `CreateAchievement` | Admin achievement creation |
| `AchievementsService` | `UpdateAchievement` | Admin achievement update |
| `AchievementsService` | `DeleteAchievement` | Admin achievement deletion |
| `AchievementsService` | `GetAdminAchievements` | Admin achievements list |
| `AchievementsService` | `GetUserAchievements` | User-facing achievement progress |

Internal/admin gRPC calls are protected with metadata:

```text
x-api-key: <INTERNAL_API_KEY>
```

`DeductPoints` and `RefundPoints` bind a successful idempotency key to the
operation, UUID user/order and positive int32 amount. The key is case sensitive,
non-empty and at most 128 characters; UUID casing is normalized. A matching retry
returns the original committed `balanceAfter`, even after later balance changes.
A different request using that key returns `success=false` with an idempotency
conflict and no effect. Profile, ledger and request/result marker commit together.
Business rejections without an effect (for example insufficient balance) do not
reserve a key and can be retried after circumstances change.

The existing `processed_events` key namespace remains global. Older/generic
markers lack request/result metadata: RPC replay returns `success=false` with
`reconciliation required`, rather than inferring a result or executing again.
The additive migration leaves these rows unchanged. Upgrade all RPC instances
before relying on payload binding; old instances ignore the added metadata.
Do not change the key to replay an ambiguous legacy operation without reconciliation.

Refund is full checkout compensation: it requires exactly one negative
`BURN_DISCOUNT` for the same UUID user/order, registered in `checkout_debits`.
The requested amount must equal the actual debit. Each debit can link to only
one refund ledger entry; another key after compensation returns `success=false`.
An exact repeat with the original key still returns its historical committed
result, including after later balance changes. Missing debit, amount mismatch,
another user/order, prior compensation and ambiguous multiple debits are refusals
without balance/ledger/idempotency effects. Partial refunds are not supported.

Migration `20261016030000_link_checkout_refunds` creates an empty registry with
ledger foreign keys and unique debit/refund references. New deduct transactions
insert their registry row atomically. It performs no legacy eligibility backfill
and no monetary updates. Existing typed successful refund markers still replay;
generic markers remain unverifiable. Stop/drain all old deduct/refund RPC
instances before migration and upgrade all instances before resuming checkout:
old refund implementations do not enforce this rule. The new table is empty,
but installing foreign keys still needs brief locks on the ledger; use a bounded
deployment lock timeout and retry rather than claiming zero downtime.

Legacy reconciliation must be per order, with old RPC writers stopped: establish
the owning user, exactly one debit and its actual amount, all prior REFUND ledger
rows/command records, payment/checkout status, and any ambiguous RPC outcome from
the coordinator's durable records. Under the same profile row lock, an operator
may insert `checkout_debits(debit_id, refund_id)` with an existing full refund ID
if already compensated, or a null refund ID only after confirming no earlier
credit. Neither registration changes balance. Retry an approved outstanding
full compensation with its stable key. Missing evidence, multiple debits,
unattributed/partial/excess credits, or disagreement must remain blocked for
manual reconciliation; never rotate keys or infer eligibility from timestamps.
A repeated debit after compensation replays its original success and does not
create a new debit. Checkout recovery after an unknown deduct result remains a
separate coordinator responsibility.

## RabbitMQ Events

| Queue / Event | Direction | Handler | Purpose |
| --- | --- | --- | --- |
| `loyalty_ticket_purchased` | inbound | `TicketPurchasedConsumer` | Processes checkout completion |
| user date of birth event | inbound | DOB consumer | Stores birthday date and may grant birthday bonus |
| `loyalty.tier_upgraded` | outbound | outbox publisher | Notifies platform about tier upgrades |
| `loyalty.points_expiring` | outbound | outbox publisher | Notifies platform about soon-to-expire points |

## BullMQ Jobs

Queue names:

```text
loyalty-queue
achievements-queue
```

| Queue | Job | Schedule / Trigger | Purpose |
| --- | --- | --- | --- |
| `loyalty-queue` | `expire-points` | every day at `03:00` | Expires outdated points |
| `loyalty-queue` | `notify-expiring` | every day at `04:00` | Marks users for expiry notifications |
| `loyalty-queue` | `annual-stats-reset` | January 1 at `00:05` | Resets `yearPoints` and `yearVisits` |
| `loyalty-queue` | `gold-reset` | first day of every month at `01:00` | Clears older GOLD usage projections; preserves the current UTC month |
| `loyalty-queue` | `grant-birthday-bonuses` | every day at `00:10 UTC` | Grants birthday bonuses |
| `achievements-queue` | `process-achievement` | domain event | Updates achievement progress and rewards |

Redis Insight key patterns:

```text
bull:loyalty-queue:*
bull:achievements-queue:*
```

## Data Model

| Table | Purpose |
| --- | --- |
| `loyalty_profiles` | Current loyalty balance, tier, yearly stats, birthday date, GOLD usage |
| `points_transactions` | Audit log for all point changes |
| `processed_events` | Idempotency for events and commands |
| `user_bonus_grants` | One-time bonus grant tracking |
| `outbox_events` | Reliable outbound domain events |
| `achievement_dispatch_intents` | Purchase achievement delivery to BullMQ, retried until accepted |
| `achievements` | Achievement definitions and criteria |
| `user_achievements` | User progress and unlock state |

## Project Structure

```text
src/
  achievements/
    constants/       achievement constants
    enums/           categories, actions, maps
    helpers/         progress calculation
    interfaces/      contracts for the achievements module
    mappers/         gRPC/domain mapping
    processors/      BullMQ achievement worker
    schemas/         Zod schemas
    validators/      validation services
  common/            shared gRPC status helpers
  config/            app, BullMQ, RabbitMQ, and CORS config
  generated/prisma/  generated Prisma client
  guards/            gRPC API key guard
  loyalty/
    consumers/       RabbitMQ consumers
    constants/       loyalty rules, queues, and cron expressions
    dto/             RabbitMQ DTOs
    events/          internal event enums/classes
    processors/      BullMQ loyalty worker
    producers/       scheduled job producer
    utils/           UTC local date utilities
  prisma/            Prisma module/service
  proto/             gRPC proto files
  utils/             shared mappers
prisma/              schema and migrations
```

## Requirements

| Requirement | Version / Notes |
| --- | --- |
| Node.js | `22` (application runtime) |
| Bun | `1.3.13` (package manager; `bun.lock` is authoritative) |
| PostgreSQL | required for Prisma datasource |
| Redis | required for BullMQ |
| RabbitMQ | required for event consumers/publishers |
| Buf CLI | optional, for proto lint/build checks |

## Environment

Example `.env`:

```env
NODE_ENV=development
PORT=3000
FRONTEND_URL=http://localhost:5173

GRPC_URL=0.0.0.0:50051
INTERNAL_API_KEY=change-me

DATABASE_URL=postgresql://postgres:postgres@localhost:5433/cinema_loyalty_db?schema=public

RMQ_URL=amqp://guest:guest@localhost:5672
RMQ_QUEUE=loyalty_ticket_purchased
RMQ_LOYALTY_EVENTS_QUEUE=loyalty.events
OUTBOX_PUBLISH_TIMEOUT_MS=10000
OUTBOX_LEASE_MS=30000
OUTBOX_PUBLISH_CONCURRENCY=5

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=redis_password

JWT_SECRET=change-me
```

RabbitMQ outbox attempts are counted when a row is claimed, including attempts
interrupted by a crash. Each claim receives a unique token and a PostgreSQL-timed
lease; expired claims retry after exponential backoff (5â€“60 seconds), and the
row's `maxAttempts` budget ends in `FAILED`. The lease must exceed the publish
timeout. Up to 50 rows are processed per tick, in immediately runnable waves
bounded by `OUTBOX_PUBLISH_CONCURRENCY` (1â€“50). A timeout ends the local wait;
the underlying send may still complete. Delivery remains at least once.

Tier notifications retain their JSON shape. `upgradedAt` comes from the persisted
outbox creation time, and AMQP `messageId` carries the stable outbox ID. Receivers
need persistent deduplication to avoid repeated side effects.

For the lease migration, stop **all old publisher instances** before starting the
new publisher. Apply the additive migration, inspect legacy `PROCESSING` rows
with no token/lease, and reconcile explicitly selected IDs against downstream
effects. The old in-flight attempt was not counted: an operator-approved retry
must account for it and respect `maxAttempts`, or mark the row `FAILED` for
investigation. There is no automatic legacy replay. Old publishers must not run
alongside the new version because their completion updates ignore ownership.

Outbox candidate selection uses PostgreSQL `statement_timestamp()` so due-time
indexes can bound the search. Lease creation and ownership checks still use
`clock_timestamp()`. Each tick separately recovers up to 50 expired claims and
fails up to 50 exhausted PENDING rows. New publishers do not produce the latter;
older publishers used a fixed budget of 5 instead of the row's `maxAttempts`.
The partial `outbox_events_exhausted_pending_idx` indexes only these exceptions;
its predicate is maintained in migration SQL, outside the Prisma schema DSL.

Migration `20261016020000_index_exhausted_outbox_pending` uses `CREATE INDEX
CONCURRENTLY`, verified with `bun x prisma migrate deploy`. Do not wrap it in a
transaction. Inspect `pg_index.indisvalid/indisready` after deployment. If building
it fails, inspect and drop the invalid index with `DROP INDEX CONCURRENTLY`, mark
that failed migration rolled back with `prisma migrate resolve --rolled-back`,
then retry deployment; do not skip an invalid index with `IF NOT EXISTS`.

The earlier lease and command-result migrations are unchanged. Their regular
index builds block writes, and the validated CHECK scans `processed_events`
under an exclusive lock. Table sizes and production lock waits are unknown.
For a large existing database where these migrations are **not yet applied**,
an operator must execute their equivalent DDL in stages before normal deploy:

1. Stop old publishers; keep new publishers/RPC instances inactive. Use a
   dedicated SQL session with a short `lock_timeout` (for example `2s`).
2. Execute the lease migration's additive ALTER; build its two indexes with
   `CREATE INDEX CONCURRENTLY` outside a transaction. Verify both indexes valid.
3. Execute the command migration's additive ALTER, then add its exact CHECK with
   `NOT VALID`. Commit before running `VALIDATE CONSTRAINT` separately; confirm
   `pg_constraint.convalidated = true`. Do not leave columns/constraint/indexes
   partially installed or mark unfinished DDL as applied.
4. Verify names, types, defaults, index definitions and CHECK against the two
   original SQL files. Record each completed equivalent migration using
   `bun x prisma migrate resolve --applied <migration-directory-name>`.
5. Run `bun x prisma migrate deploy` for the new concurrent partial index, then
   activate new instances and perform the legacy-row reconciliation above.

This staged DDL was checked on disposable PostgreSQL 16, including the
`ShareUpdateExclusiveLock` held by CHECK validation. Initial ALTER statements
still need short exclusive locks; concurrent builds/validation consume I/O and
may wait for existing transactions. Already-applied migrations must not be
replayed or edited. Fresh empty databases can use normal `migrate deploy`.

## Local Setup

GitHub Actions runs verification on pull requests: Bun 1.3.13 frozen install,
Prisma generation, lint, build, Jest, disposable PostgreSQL integration tests,
and a production Docker build without pushing an image. It has read-only
repository permissions and uses no SSH or deployment secrets. Transport tests
remain local because they build the adjacent `cinema-platform-back` checkout;
see `bun run test:transports` and `test/e2e/compose.override.yml`.

Automatic deployment is deliberately disabled. The former push-to-master SSH
workflow has been removed until a working environment and the migration rollout
procedure are agreed. Merging this PR does not deploy the service.

```bash
bun install --frozen-lockfile
bun x prisma generate
bun x prisma migrate deploy
bun run start:dev
```

For local development with new migrations:

```bash
bun x prisma migrate dev
```

Validate proto files:

```bash
bun run buf:lint
bun run buf:build
```

Production build:

```bash
bun run build
bun run start:prod
```

`bun run start:prod` launches `dist/main.js` with Node.js 22. Bun remains the package manager and script runner. The Docker build uses Bun 1.3.13 for frozen installs in both stages and Node.js 22 for the application process.

The pull request workflow runs the same install, Prisma generation, lint, build, and Jest checks:

```bash
bun install --frozen-lockfile
bun x prisma generate
bun run lint
bun run build
bun run test
```

Concurrency tests use real PostgreSQL 16 and require a running Docker Engine:

```bash
bun run test:integration
```

The runner creates a disposable Compose project with a random loopback port, applies the existing migrations, runs Jest, and removes the containers and data afterwards. It supplies its own database URL. The normal `bun run test` suite needs no external services. PR CI runs both suites.

See [profile concurrency and integration notes](docs/profile-concurrency.md) for the writer audit, lock discipline, regression coverage, and monolith compatibility findings.

For HTTP checkout through the sibling `../cinema-platform-back` repository, real gRPC/RabbitMQ/BullMQ delivery, and loyalty Redis outage recovery:

```bash
bun run test:transports
```

This requires Docker Compose 2.24.4+ and BuildKit additional contexts. The runner builds the monolith in .NET 10 containers, runs its checkout characterization tests, migrates disposable databases, and uses random loopback ports. Monolith sources are copied into the build context; no host source mount is writable. Only resources belonging to this test project are removed. Results and repository SHAs are written under `.tmp/`. This optional suite requires both repositories and is separate from PR CI.

Achievement intents are saved atomically with purchases. A publisher polls every five seconds, retries unavailable Redis, and uses the intent UUID as the BullMQ job ID. `delivered_at` means queue acceptance; achievement effects retain their PostgreSQL deduplication. Apply migrations before starting the updated service. See [delivery guarantees, E2E evidence, and remaining limits](docs/achievement-delivery.md).

After startup, the service runs:

| Runtime Part | Source |
| --- | --- |
| HTTP server | `PORT` |
| gRPC microservice | `GRPC_URL` |
| RabbitMQ microservice | `RMQ_QUEUE` |
| BullMQ workers | `loyalty-queue`, `achievements-queue` |

### Runtime environment validation

The application validates its environment with Zod 4 during Nest dependency creation,
before lifecycle hooks, gRPC/RabbitMQ listeners, or HTTP become available. ConfigModule
loads one parsed snapshot; `app` and `rmqDelivery` lookup namespaces are preserved.
Their former `registerAs` factories are now pure mappings of that snapshot. Consumers
use inferred ConfigService types; raw process.env fallback is disabled. Missing or
invalid settings stop startup with variable names only, without secret values.

| Variables | Required / default | Validation |
| --- | --- | --- |
| `DATABASE_URL` | Required | `postgres://` or `postgresql://`; host or PostgreSQL socket host query; existing credentials/query parameters supported |
| `INTERNAL_API_KEY` | Required | Nonblank string; no new length/format requirement |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Required | Nonblank host without scheme; TCP port 1..65535; password may explicitly be empty for passwordless Redis |
| `PORT` | `3000` | TCP port 1..65535 |
| `GRPC_URL` | `0.0.0.0:50051` | `host:port` or `[IPv6]:port`, TCP port 1..65535 |
| `FRONTEND_URL` | `http://localhost:3000` | Single HTTP(S) origin, no credentials, path (except `/`), query or fragment; normalized to URL.origin (case/default port/trailing slash); credentials/methods/headers policy unchanged |
| `RMQ_URL` | `amqp://localhost:5672` | AMQP(S) connection URL with host; credentials and virtual hosts supported |
| `RMQ_QUEUE` | `loyalty_ticket_purchased` | Nonblank inbound purchase/DOB queue |
| `RMQ_LOYALTY_EVENTS_QUEUE` | `loyalty.events` | Nonblank outbound loyalty event queue, distinct from inbound |
| `OUTBOX_PUBLISH_TIMEOUT_MS` | `10000` | Integer 1..2147483647 |
| `OUTBOX_LEASE_MS` | `max(30000, timeout + 5000)` | Integer greater than timeout and at most 2147483647; an overflowing derived default is rejected, never clamped |
| `OUTBOX_PUBLISH_CONCURRENCY` | `5` | Integer 1..50 |
| `RMQ_MAX_ATTEMPTS` | `3` | Integer 1..10 |
| `RMQ_PREFETCH` | `5` | Integer 1..50 |
| `RMQ_RETRY_BASE_MS` | `1000` | Integer 50..60000 |
| `RMQ_RETRY_MAX_MS` | `30000` | Integer at least retry base, at most 300000 |
| `RMQ_DELIVERY_LEASE_MS` | `30000` | Integer 10000..300000 |

Numeric environment strings must contain decimal digits only. Empty strings, fractions,
partial values such as `3000oops`, scientific/hexadecimal notation, NaN and Infinity
are rejected. Defaults apply to absent optional variables, not explicit empty values.
Before updating, check deployment values against this table: blank credentials/hosts,
malformed ports/URLs, or a wildcard/path in FRONTEND_URL now cause an early error rather
than a later connection failure or ineffective CORS behavior. No new variable is required
for an already correctly configured application. Redis remains explicitly passwordless
when REDIS_PASSWORD is present but empty. Validation checks syntax, not connectivity,
credential strength, TLS availability or broker permissions.

Prisma CLI still loads DATABASE_URL through prisma.config.ts independently of Nest;
generate/build do not require application secrets. Quarantine replay validates only
DATABASE_URL, RMQ_URL and RMQ_QUEUE and does not require Redis, the API key or HTTP settings.
NODE_ENV/NODE_OPTIONS are Node/tool settings; JWT_SECRET is unused by this service and
is not required. Runner-only INTEGRATION_*, RMQ_TEST_*, E2E_* and MONOLITH_REPO values are
not application configuration. Unknown environment keys are ignored and never included
in the parsed config. Do not print the parsed configuration: it contains credentials.

No schema/data migration or coordinated broker change is needed for this configuration
update. Retain the previous image/config for rollback; reverting does not undo events
already committed by either application version.

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run build` | Build NestJS project |
| `bun run start` | Start app once |
| `bun run start:dev` | Start app in watch mode |
| `bun run start:prod` | Start compiled app with Node.js from `dist/main.js` |
| `bun run lint` | Run ESLint without modifying files |
| `bun run test` | Run Jest unit and regression tests |
| `bun run test:integration` | Run concurrency integration tests on disposable PostgreSQL 16 (Docker required) |
| `bun run test:rmq` | Run inbound retry/quarantine/replay tests on disposable PostgreSQL and RabbitMQ (Docker required) |
| `bun run test:transports` | Run monolith HTTP checkout and loyalty transport/recovery tests on an isolated Docker stack |
| `bun run test:cov` | Run Jest tests with coverage |
| `bun run test:e2e` | Run Jest e2e tests |
| `bun run buf:lint` | Lint proto files |
| `bun run buf:build` | Validate proto build |

## Useful SQL Checks

Loyalty profiles:

```sql
select user_id, tier, balance, lifetime_points, year_points, year_visits,
       balance_expires_at, last_expiry_notification_at, gold_upgrade_used_month
from loyalty_profiles
order by user_id;
```

Transactions:

```sql
select user_id, type, points, balance_after, order_id, description, created_at
from points_transactions
order by created_at desc;
```

Birthday grants:

```sql
select user_id, type, grant_year, points, granted_at
from user_bonus_grants
order by granted_at desc;
```

Achievement progress:

```sql
select a.code, ua.current, ua.target, ua.is_unlocked, ua.unlocked_at
from user_achievements ua
join achievements a on a.id = ua.achievement_id
order by a.code;
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Cannot find module './internal/class.js'` | Run `bun x prisma generate` and rebuild |
| Proto file not found in `dist` | Check `cwd` and make sure `src/proto` or `dist/proto` exists |
| Completed BullMQ jobs disappear | Production jobs may remove completed entries |
| Redis key is not named `completed` | Open the concrete job hash, for example `bull:loyalty-queue:<job-id>` |

BullMQ state indexes are stored separately:

```text
bull:loyalty-queue:delayed
bull:loyalty-queue:completed
bull:loyalty-queue:failed
```

## Automated quality analysis and review

`.coderabbit.yaml` configures assertive reviews, including Draft PRs, with focused
accounting, delivery, PostgreSQL, test and CI instructions. Install/enable the
CodeRabbit GitHub App for this repository to activate it. Automatic approvals and
requests for changes are disabled; keep AI review advisory in repository branch
protection settings. Built-in security tools retain their defaults.

SonarQube Cloud project `ModusTeam_cinema-loyalty-service` (organization
`modusteam`) currently uses **Automatic Analysis**. `sonar-project.properties`
prepares CI-based source/test scopes and LCOV import, but Automatic Analysis ignores
that file and does not import coverage. No second scanner pipeline is enabled.
Until switching, apply the generated-code exclusion `src/generated/prisma/**` in
SonarQube Cloud **Administration > General Settings > Analysis Scope > Files**.

To activate coverage and the existing Quality Gate:

1. Confirm project permissions and store a scoped analysis token as GitHub Actions
   secret `SONAR_TOKEN`; never commit it. Confirm the plan supports PR analysis.
2. In SonarQube Cloud **Administration > Analysis Method**, turn off Automatic
   Analysis. Coordinate this with the scanner change to avoid concurrent pipelines.
3. The existing CI job includes the official SonarSource scan action v8.3.0,
   pinned to verified SHA `d209202bc7d53ff1cc128f7f907dac145c9d6ae9`, after
   all test/build gates, with full Git history (`fetch-depth: 0`). After disabling
   Automatic Analysis, set repository Actions variable `SONAR_CI_ENABLED=true`.
   Leave it unset/false until then: the scanner is skipped, preventing a competing
   pipeline. To pause CI analysis, set the variable to false before re-enabling
   Automatic Analysis. No external settings are changed by the workflow.
   Analysis runs on same-repository PRs and pushes to `master`; feature branch
   pushes do not create duplicate runs. Fork PRs and Dependabot runs execute all
   existing test/build gates but skip the token-bearing scan step. Review these
   PRs independently and analyze their merged commit on `master`; do not require
   an unavailable PR Sonar check for these cases or expose secrets through
   `pull_request_target` as a workaround. A skipped scan is not a passed Quality Gate.
4. CI already runs `bun run test:cov --runInBand` once in place of the unit test
   command. Jest produces `coverage/lcov.info`; import it using the properties
   file. This is **unit coverage**, not combined integration/transport coverage.
5. Verify the first cloud analysis: source/test scopes are disjoint, generated
   Prisma code is absent, LCOV paths resolve, and New Code coverage is populated.
   The scanner waits for the existing Quality Gate (`sonar.qualitygate.wait=true`)
   and fails CI if it fails; no thresholds are overridden. Configure required
   checks in branch protection only after observing the first successful scan,
   accounting for fork/Dependabot skips. Keep all CI gates.

`src/generated/prisma/` is reproducible output of the locked Prisma generator.
CI and the Docker builder generate it before compilation; Node runs compiled
artifacts from `dist`. Jest coverage, Sonar CI scopes and CodeRabbit exclude this
directory, while `prisma/schema.prisma` and SQL migrations remain in review scope.
The generated client is ignored and is not tracked in Git. After installing
dependencies on a clean checkout, run `bun x --no-install prisma generate` before
building or testing, and repeat generation after schema changes. CI and Docker
already perform this step. Local generated files are preserved when removing
them from Git tracking.

Official references: [Sonar automatic analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis),
[LCOV import](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/javascript-typescript-test-coverage),
[CodeRabbit configuration](https://docs.coderabbit.ai/reference/configuration).


## Related Documentation

| File | Purpose |
| --- | --- |
| [`src/proto/loyalty/v1/loyalty.proto`](src/proto/loyalty/v1/loyalty.proto) | gRPC API contract |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Database model |

## License

Internal / UNLICENSED.

## Admin pagination and runtime

Admin transaction history and user lists enforce a maximum page size of 100 in loyalty itself. Omitted limit or protobuf `limit=0` selects 50; limits 1–100 are accepted. Negative, fractional, non-finite or over-limit values return gRPC `INVALID_ARGUMENT`. Omitted/zero skip selects 0; negative/fractional/non-finite skip is rejected. Existing filters and total counts are unchanged. Current monolith admin validators already require limit 1–100 and nonnegative skip.

The production image runs compiled Node.js 22 as the existing unprivileged `node` user (UID/GID 1000). Install/build and migrations remain separate from application startup. Dist artifacts are owned by `node`; dependencies are readable without application write access. Container startup requires existing PostgreSQL/Redis/RabbitMQ configuration and schema. The image does not require privileged ports. HTTP uses a single configured CORS policy; CORS is browser response policy, not authentication or network encryption.
