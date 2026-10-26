CREATE TYPE "CustomerFactState" AS ENUM ('PENDING', 'APPLIED', 'BLOCKED');

CREATE TABLE customer_facts_projections (
  user_id UUID PRIMARY KEY,
  applied_revision INTEGER NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  source_event_id UUID,
  occurred_at_utc TIMESTAMPTZ(3),
  registered_at_utc TIMESTAMPTZ(3),
  dob_first_set_at_utc TIMESTAMPTZ(3),
  date_of_birth DATE,
  last_applied_at TIMESTAMPTZ(3),
  CONSTRAINT customer_projection_position CHECK (
    (applied_revision = 0 AND source_event_id IS NULL AND occurred_at_utc IS NULL AND last_applied_at IS NULL)
    OR (applied_revision > 0 AND source_event_id IS NOT NULL AND occurred_at_utc IS NOT NULL AND last_applied_at IS NOT NULL)
  )
);

CREATE TABLE customer_fact_receipts (
  event_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES customer_facts_projections(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload JSONB NOT NULL,
  fingerprint VARCHAR(64) NOT NULL,
  state "CustomerFactState" NOT NULL DEFAULT 'PENDING',
  received_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TIMESTAMPTZ(3),
  error_code VARCHAR(64),
  recheck_count INTEGER NOT NULL DEFAULT 0 CHECK (recheck_count >= 0),
  rechecked_at TIMESTAMPTZ(3),
  CONSTRAINT customer_receipt_state CHECK (
    (state = 'APPLIED' AND applied_at IS NOT NULL AND error_code IS NULL)
    OR (state = 'PENDING' AND applied_at IS NULL AND error_code IS NULL)
    OR (state = 'BLOCKED' AND applied_at IS NULL AND error_code IS NOT NULL)
  )
);
CREATE UNIQUE INDEX customer_fact_receipts_user_id_revision_key
  ON customer_fact_receipts(user_id, revision);
-- Recovery polls only actionable PENDING receipts; keep retained APPLIED history out of this scan.
CREATE INDEX customer_fact_receipts_pending_next_idx
  ON customer_fact_receipts(user_id, revision) WHERE state = 'PENDING';
