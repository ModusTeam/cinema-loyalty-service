# Конкурентні зміни loyalty profile

Baseline: `cfc5fb4` поверх `d3f1bc5`. Frozen install, build і 12 Jest-тестів проходили; lint мав одне попередження `no-floating-promises` у `main.ts`.

## Відтворення та аудит writer-ів

На PostgreSQL 16 до виправлення два різні списання по 80 з балансу 100 повертали `success=true`, `balanceAfter=20`. Блокувальна DB-сесія утримувала рядок профілю; тест перевіряв через `pg_stat_activity`, що обидва writer-и одночасно очікують блокування, і лише потім відпускав рядок.

| Операція | Попередній read/write | Ризик | Захист зараз |
| --- | --- | --- | --- |
| Purchase | Read профілю, абсолютний запис balance/lifetime/year/visits/tier/expiry | Lost update, застарілий multiplier/tier | Profile lock до dedupe, читання й розрахунків |
| Deduct | Read balance, перевірка, абсолютний запис | Дві успішні команди за недостатнього сумарного балансу | Перевірка актуального балансу під lock; відмова не створює ledger |
| Refund | Read balance, абсолютний запис | Refund або інший writer перезаписує результат | Profile lock до dedupe та читання |
| Admin points | Перевірка balance, atomic increments, абсолютний tier | Дві перевірки проходять; від’ємний баланс, stale tier | Profile lock до перевірки; ledger/outbox в тій самій транзакції |
| Admin VIP | Read tier поза транзакцією; запис GOLD і outbox | Purchase повертає старий tier; хибний oldTier | Read і перевірка перенесені під profile lock |
| Birthday: DOB event / scheduler | Unique grant, increments, розрахунок tier | Stale tier; purchase може перезаписати приріст | Profile lock перед grant dedupe; повторна перевірка актуального DOB; unique constraint збережений |
| Achievement reward | Dedupe/progress, atomic balance/lifetime increment | Purchase може перезаписати reward; гонки progress | Profile lock перед dedupe/progress/reward |
| Expiry | Snapshot пачки, обнулення, ledger зі snapshot | Стирає продовжений баланс; неправильна сума EXPIRE | Окрема транзакція на профіль; повторні balance/expiry під lock |
| Annual reset | Batch update yearPoints/yearVisits | Purchase повертає старі лічильники після reset | Окрема транзакція на профіль із тим самим lock |

`getBalance`, `getFullProfile`, admin balance lookup лише створюють порожній профіль або читають його. Вони не перезаписують гроші чи лічильники існуючого профілю. GOLD use/rollback/reset і expiry notifications змінюють окремі поля: їхні UPDATE також беруть стандартні PostgreSQL row locks, а абсолютних записів перелічених вище полів у цих шляхах немає.

## Дисципліна транзакцій

Обрано `READ COMMITTED` з `SELECT ... FOR UPDATE` для одного профілю на транзакцію. Conditional atomic update добре захистив би тільки перевірку достатності balance; для multiplier, tier, counter, ledger та outbox усе одно потрібен узгоджений актуальний стан. Optimistic concurrency потребувала б version field та обробки конфліктів у кожному writer-і.

- `withTransactionRetry` відкриває верхню транзакцію. Весь callback використовує переданий `tx`; вкладених незалежних транзакцій немає.
- `lockLoyaltyProfile` працює лише на переданому transaction client. Порядок: profile → processed event / bonus grant / achievement progress → ledger/outbox. Кожна транзакція змінює один профіль, тому batch jobs не утримують кілька profile locks одночасно.
- Для writer-ів, які можуть створювати профіль, `INSERT ... ON CONFLICT DO NOTHING` спирається на unique `user_id` перед row lock. Це також захищає конкурентне створення. Achievement processing тепер ініціалізує порожній профіль до progress; бали нараховуються лише за чинними умовами unlock/reward.
- Якщо рядка не було під час lock у deduct/refund/expiry, цей writer не може потім прочитати й змінити щойно створений незаблокований профіль.
- На commit разом зберігаються profile, ledger, dedupe/grants/progress та наявні tier outbox records. Наявність outbox для кожного виду зміни не додається.
- Achievement intents зберігаються тим самим transaction client разом із purchase; окремий publisher передає їх у BullMQ після commit. RabbitMQ/Redis-викликів усередині DB-транзакцій немає.
- `P2034`, а також SQLSTATE `40001`/`40P01` у Prisma pg adapter errors (ORM або raw SQL `P2010`) повторюються максимум тричі загалом. Між спробами є затримки 10 і 20 ms поза транзакцією. Інші помилки не повторюються. Після вичерпання спроб діє чинний service error contract.
- Expiry повторно перевіряє `balance > 0` і `balanceExpiresAt <=` час початку job. Ledger отримує фактичний поточний balance. Обробка пачки тепер має більше коротких транзакцій замість одного batch UPDATE; це плата за точність і коротке утримання locks.

Правила збережено: achievement reward збільшує тільки balance/lifetimePoints; refund не продовжує expiry; birthday grants і positive admin adjustments продовжують expiry; annual reset обнуляє статистику в момент його серіалізації для конкретного профілю. Нової семантики calendar-year boundary, refund або GOLD тут немає.

## Integration tests

`bun run test:integration` створює ізольований PostgreSQL 16 через `test/docker-compose.integration.yml`, застосовує наявні migrations і запускає Jest. Prisma та PostgreSQL справжні; замінено лише недотичні queue/broker adapters. Порт випадковий і доступний лише на loopback. Дані очищуються між тестами; Compose stack видаляється runner-ом у `finally`.

Suite перевіряє два списання; два нарахування; purchase/deduct; refund/deduct; admin deductions; achievement/purchase; expiry після продовження; фактичну суму expiry після списання; rollback profile/ledger/outbox/dedupe через PostgreSQL trigger; повтори deduct/refund/purchase/birthday/achievement; annual reset; переходи tier; scheduled birthday; VIP/purchase; відсутній профіль; конкурентне створення; PostgreSQL conflict retry та його ліміт.

Перевірка concurrency етапу: 27 integration tests і 12 наявних unit/regression tests пройшли; build пройшов; lint має лише baseline-попередження в `main.ts`. Після додавання durable intents suite містить 31 тест: додано atomic purchase/VIP intents, rollback при помилці intent INSERT, retry після Redis/DB failure зі сталим job ID і enqueue timeout. Docker Compose setup не залишив контейнерів після завершення. PR CI запускає integration command; сам віддалений GitHub workflow у межах цієї роботи не запускався.

Для пар writer-ів використовується утримуваний row lock і підтвердження двох сесій у `pg_stat_activity`. Для expiry тест блокує перший профіль із пачки, виконує реальне поповнення/списання другого кандидата після вибору пачки й лише потім дозволяє expiry продовжити. SQLSTATE та outbox failure інжектуються функціями/trigger-ами в disposable DB; production schema не змінюється.

Jest для Prisma 7 dynamic imports запускається з `--experimental-vm-modules` через `NODE_OPTIONS` тільки integration runner-а. Default unit suite залишається без інфраструктури.

## Моноліт: читання коду й окремі пропозиції

Перевірені тільки релевантні файли `cinema-platform-back`:

- `src/Cinema.Infrastructure/Services/GrpcLoyaltyService.cs`: передає userId, amount, orderId, idempotencyKey та `x-api-key`; preview передає orderAmount. Deduct/refund ловлять `RpcException` і повертають false з повідомленням. Preview передає RPC-помилку виклику вище.
- `src/Modules/Orders/Cinema.Orders.Application/Orders/Services/OrderCheckoutOrchestrator.cs`: deduct key = `DeterministicGuid.Create("deduct-{orderId}")`, refund key = `DeterministicGuid.Create("refund-{orderId}")`. Preview false означає повну грошову оплату. Deduct false зупиняє checkout до платежу. Помилка preview повертає `Loyalty.Unavailable`. Компенсація після payment failure/exception використовує стабільний refund key; невдача компенсації логуються для manual reconciliation.
- `src/Cinema.Infrastructure/ConfigureInfrastructureServices.cs`: у registration loyalty gRPC client задається адреса. Явного deadline/retry policy в цьому registration і loyalty client немає; передається cancellation token виклику. У checkout немає власного циклу повторів loyalty RPC.
- `src/Modules/Orders/Cinema.Orders.Application/EventHandlers/OrderPaidIntegrationEventHandler.cs` та `src/Cinema.Application/Orders/IntegrationEvents/NestJsTicketPurchasedEnvelope.cs`: envelope з pattern `TicketPurchased`; eventId/orderId = order.Id; data містить userId, totalAmount, ticketAmount, foodAmount, eventType, purchasedAt, paidAmount, pointsUsed та додаткові metadata. Ці поля сумісні з наявним consumer; wire contracts у loyalty-service не змінені.

Пропозиції власнику моноліту (файли моноліту не змінені):

1. Додати явні обмежені RPC deadlines та визначену політику transient retry з тими самими idempotency keys. Причина: cancellation/timeout може настати після commit у loyalty. Поточний клієнт повертає false, checkout позначає order failed і не викликає компенсацію для непідтвердженого deduct. Наслідок — можливе списання за failed order навіть за правильного локального balance.
2. Зберігати та відновлювати неоднозначний результат deduct/refund через durable reconciliation. Повтор з тим самим ключем може підтвердити вже виконаний ефект; порядок відновлення має бути визначений до компенсації. Невдала refund compensation зараз лише логуються, тому автоматичної гарантії відновлення немає. Для відновлення після request cancellation потрібен окремий життєвий цикл, а не вже скасований request token.

Під час початкового concurrency етапу спільний стенд не запускався. Наступна перевірка зібрала ізольований стенд із сусіднього репозиторію та перевірила HTTP checkout, gRPC deduction, RabbitMQ і Redis recovery. Версії, точні сценарії й межі наведено в [achievement-delivery.md](achievement-delivery.md).

## Залишкові межі

Locks захищають writer-и цього сервісу; прямий SQL або новий writer має дотримуватися тієї самої дисципліни. Навантаження, contention latency та calendar-year boundary потребують окремої оцінки. Збережені обмеження існуючої idempotency (namespace/payload semantics), refund і GOLD flow.

Наступний запланований крок, durable dispatch achievements, включено за окремим погодженням користувача: purchase та intents тепер атомарні, доставка в BullMQ повторюється незалежно від повтору purchase. Історичні пропущені події автоматично не відновлюються. RabbitMQ outbox lease recovery та зв'язування deduct/refund keys із request/result також реалізовані; їхні межі й порядок оновлення наведені в README. Redis durability та операційне відновлення вичерпаних BullMQ jobs залишаються окремими задачами.

## Dormant source-linked checkout debit

`debitCheckoutPoints(tx, { userId, orderId, amount, idempotencyKey })` in `src/loyalty/points-allocation.ts` is an internal opt-in primitive. It requires a caller-owned READ COMMITTED interactive transaction and an existing profile. It takes the profile lock, checks the existing `processed_events` command result first, then uses one database decision time for spendable availability and FEFO funding. A fresh debit commits its negative `BURN_DISCOUNT` ledger entry, `CheckoutDebit`, redemption, funding, profile balance/activity, and saved command result in that same transaction. Propagated errors require the caller to roll back; do not catch them inside the transaction and commit partial work. It opens no nested transaction and performs no network calls.

Before a fresh debit, profile balance must equal source **spendable** points, not accounting remainder. An inconsistent profile fails closed with `Source balance projection mismatch`; the primitive performs no reconciliation or historical backfill. An exact command replay returns its original result even after balance changes or source expiry. Historical successful commands without source bindings also replay their saved result without fabricating allocations; generic legacy event keys retain their existing rejection semantics. The existing minimum deduction remains **75** (`LOYALTY_RULES.MINIMUM_DEDUCTION`); the economy specification's target of 25 requires a separate coordinated business activation. The trusted caller owns order eligibility and purchase caps, which cannot be checked from this primitive's inputs.

The optional, unique `PointRedemption.checkoutDebitId` and `commandEventId` explicitly bind the ledger UUID (also `debitRef`) and the arbitrary string command key. PostgreSQL validates user ownership, negative debit type/amount, order, DEDUCT command payload and historical balance, and prevents changes to linked facts. Standalone allocation operations and historical checkout rows may remain unbound; migration does not infer or populate links.

This primitive is not connected to public gRPC, `LoyaltyService.deductPoints`, refund orchestration, active expiry, admin, birthday, or achievement writers. The existing debit-linked full refund can still compensate its checkout ledger, but does not restore source funding. Source-preserving checkout refunds and coordinated writer/read cutover remain prerequisites to activation. No earning policy, debt, outbox, or external checkout integration is introduced.

Regression coverage is in `test/integration/checkout-debits.integration-spec.ts`, alongside the existing allocation, restoration, availability, expiry, and point-command idempotency PostgreSQL suites.
