BEGIN;

ALTER TABLE point_sources
  ADD COLUMN expired bigint NOT NULL DEFAULT 0 CHECK (expired >= 0),
  ADD COLUMN extended_expired bigint NOT NULL DEFAULT 0 CHECK (extended_expired >= 0 AND extended_expired <= expired);

CREATE TABLE point_expiry_operations (
  user_id uuid NOT NULL, operation_id uuid NOT NULL, source_id uuid NOT NULL,
  decision_at timestamptz(3) NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  applied integer NOT NULL DEFAULT 0 CHECK (applied >= 0 AND applied <= amount),
  PRIMARY KEY (user_id, operation_id), UNIQUE (user_id, operation_id, source_id),
  FOREIGN KEY (user_id, source_id) REFERENCES point_sources(user_id, source_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX point_expiry_operations_source_idx ON point_expiry_operations(user_id, source_id);
CREATE TABLE point_expiry_entries (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, operation_id uuid NOT NULL, source_id uuid NOT NULL,
  bucket varchar(8) NOT NULL CHECK (bucket IN ('ORIGINAL', 'EXTENDED')),
  amount integer NOT NULL CHECK (amount > 0), deadline timestamptz(3) NOT NULL,
  credit_watermark bigint NOT NULL CHECK (credit_watermark >= 0),
  UNIQUE (user_id, source_id, bucket, credit_watermark),
  UNIQUE (user_id, operation_id, bucket),
  FOREIGN KEY (user_id, operation_id, source_id) REFERENCES point_expiry_operations(user_id, operation_id, source_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Keep prior funding/redemption/restoration guards; replace only source checks.
CREATE FUNCTION point_source_expiry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[] := ARRAY['remaining', 'extended_remaining'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.expired <> 0 OR NEW.extended_expired <> 0 THEN
      RAISE EXCEPTION 'initial expiry totals must be zero';
    END IF;
  ELSE
    IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'point allocation facts are immutable'; END IF;
    IF pg_trigger_depth() > 1 THEN
      allowed := allowed || ARRAY['spent', 'restored', 'extended_spent', 'extended_restored', 'expired', 'extended_expired'];
    END IF;
    IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'point allocation facts are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER point_sources_immutable ON point_sources;
CREATE TRIGGER point_sources_immutable BEFORE INSERT OR UPDATE OR DELETE ON point_sources FOR EACH ROW EXECUTE FUNCTION point_source_expiry_guard();

CREATE FUNCTION point_source_expiry_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM point_sources s WHERE s.user_id = NEW.user_id AND s.source_id = NEW.source_id
    AND (s.remaining::numeric + s.spent::numeric + s.expired::numeric <> s.granted::numeric + s.restored::numeric
      OR s.extended_remaining::numeric + s.extended_spent::numeric + s.extended_expired::numeric <> s.extended_restored::numeric)) THEN
    RAISE EXCEPTION 'point source conservation violated';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER point_sources_conservation ON point_sources;
CREATE CONSTRAINT TRIGGER point_sources_conservation AFTER INSERT OR UPDATE ON point_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_source_expiry_conservation();

-- Lock the current remainder for SQL callers as well as cooperating helpers.
CREATE FUNCTION point_expiry_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE due integer; s point_sources%ROWTYPE; extension_deadline timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO s FROM point_sources WHERE user_id = NEW.user_id AND source_id = NEW.source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'point expiry source not found'; END IF;
    SELECT expires_at INTO extension_deadline FROM point_source_extensions WHERE user_id = NEW.user_id AND source_id = NEW.source_id;
    due := CASE WHEN s.original_expires_at <= NEW.decision_at THEN s.remaining - s.extended_remaining ELSE 0 END
      + CASE WHEN extension_deadline <= NEW.decision_at THEN s.extended_remaining ELSE 0 END;
    IF NEW.applied <> 0 OR NEW.amount <> due OR NEW.decision_at > points_decision_time() THEN
      RAISE EXCEPTION 'point expiry operation snapshot mismatch';
    END IF;
  ELSIF TG_OP <> 'UPDATE' OR pg_trigger_depth() <= 1
    OR (to_jsonb(NEW) - 'applied') IS DISTINCT FROM (to_jsonb(OLD) - 'applied') THEN
    RAISE EXCEPTION 'point expiry operation facts are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_expiry_operations_guard BEFORE INSERT OR UPDATE OR DELETE ON point_expiry_operations FOR EACH ROW EXECUTE FUNCTION point_expiry_operation_guard();
CREATE FUNCTION point_expiry_operation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM point_expiry_operations WHERE user_id = NEW.user_id AND operation_id = NEW.operation_id AND amount <> applied) THEN
    RAISE EXCEPTION 'point expiry operation incomplete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER point_expiry_operations_complete AFTER INSERT OR UPDATE ON point_expiry_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_expiry_operation_complete();

CREATE FUNCTION point_expiry_entry_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s point_sources%ROWTYPE; h point_expiry_operations%ROWTYPE; expected_deadline timestamptz; watermark bigint; quantity integer;
BEGIN
  SELECT * INTO s FROM point_sources WHERE user_id = NEW.user_id AND source_id = NEW.source_id FOR UPDATE;
  SELECT * INTO h FROM point_expiry_operations WHERE user_id = NEW.user_id AND operation_id = NEW.operation_id AND source_id = NEW.source_id FOR UPDATE;
  IF s.source_id IS NULL OR h.operation_id IS NULL THEN RAISE EXCEPTION 'point expiry source or operation not found'; END IF;
  IF NEW.bucket = 'ORIGINAL' THEN
    quantity := s.remaining - s.extended_remaining;
    expected_deadline := s.original_expires_at;
    watermark := s.restored - s.extended_restored;
  ELSE
    quantity := s.extended_remaining;
    SELECT expires_at INTO expected_deadline FROM point_source_extensions WHERE user_id = NEW.user_id AND source_id = NEW.source_id;
    watermark := s.extended_restored;
  END IF;
  IF NEW.bucket NOT IN ('ORIGINAL', 'EXTENDED') OR expected_deadline IS NULL
    OR NEW.deadline <> expected_deadline OR h.decision_at < expected_deadline
    OR NEW.amount <> quantity OR NEW.credit_watermark <> watermark THEN
    RAISE EXCEPTION 'point expiry entry must match full due bucket';
  END IF;
  UPDATE point_sources SET remaining = remaining - NEW.amount,
    extended_remaining = extended_remaining - CASE WHEN NEW.bucket = 'EXTENDED' THEN NEW.amount ELSE 0 END,
    expired = expired + NEW.amount::bigint,
    extended_expired = extended_expired + CASE WHEN NEW.bucket = 'EXTENDED' THEN NEW.amount::bigint ELSE 0 END
    WHERE user_id = NEW.user_id AND source_id = NEW.source_id;
  UPDATE point_expiry_operations SET applied = applied + NEW.amount WHERE user_id = NEW.user_id AND operation_id = NEW.operation_id;
  RETURN NEW;
END $$;
-- Apply only rows that survived uniqueness arbitration, including ON CONFLICT.
CREATE TRIGGER point_expiry_entries_apply AFTER INSERT ON point_expiry_entries FOR EACH ROW EXECUTE FUNCTION point_expiry_entry_apply();
CREATE TRIGGER point_expiry_entries_immutable BEFORE UPDATE OR DELETE ON point_expiry_entries FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();
COMMIT;
