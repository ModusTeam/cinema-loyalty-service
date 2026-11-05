BEGIN;

-- Aggregate remaining includes expired original points. Only extended_remaining
-- can be spent after original expiry; opening an extension never revives them.
ALTER TABLE point_sources
  ADD COLUMN extended_remaining integer NOT NULL DEFAULT 0 CHECK (extended_remaining >= 0 AND extended_remaining <= remaining),
  ADD COLUMN spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  ADD COLUMN restored bigint NOT NULL DEFAULT 0 CHECK (restored >= 0),
  ADD COLUMN extended_spent bigint NOT NULL DEFAULT 0 CHECK (extended_spent >= 0),
  ADD COLUMN extended_restored bigint NOT NULL DEFAULT 0 CHECK (extended_restored >= 0);
ALTER TABLE point_funding ADD COLUMN extended_amount integer NOT NULL DEFAULT 0 CHECK (extended_amount >= 0 AND extended_amount <= amount);

DROP TRIGGER point_sources_immutable ON point_sources;
-- Derived totals for existing dormant allocations, never historical grants.
UPDATE point_sources s SET spent = totals.spent
FROM (SELECT user_id, source_id, sum(amount::bigint) AS spent FROM point_funding GROUP BY user_id, source_id) totals
WHERE s.user_id = totals.user_id AND s.source_id = totals.source_id AND s.spent <> totals.spent;

CREATE TABLE point_restorations (
  user_id uuid NOT NULL, restoration_id uuid NOT NULL, redemption_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  credited integer NOT NULL DEFAULT 0 CHECK (credited >= 0 AND credited <= amount),
  restored_at timestamptz(3) NOT NULL,
  PRIMARY KEY (user_id, restoration_id), UNIQUE (user_id, redemption_id),
  UNIQUE (user_id, restoration_id, redemption_id),
  FOREIGN KEY (user_id, redemption_id) REFERENCES point_redemptions(user_id, redemption_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE point_source_extensions (
  user_id uuid NOT NULL, source_id uuid NOT NULL, restoration_id uuid NOT NULL,
  opened_at timestamptz(3) NOT NULL, expires_at timestamptz(3) NOT NULL CHECK (expires_at > opened_at),
  PRIMARY KEY (user_id, source_id),
  FOREIGN KEY (user_id, source_id) REFERENCES point_sources(user_id, source_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (user_id, restoration_id) REFERENCES point_restorations(user_id, restoration_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE point_restoration_splits (
  user_id uuid NOT NULL, restoration_id uuid NOT NULL, redemption_id uuid NOT NULL, source_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0), expires_at timestamptz(3) NOT NULL,
  PRIMARY KEY (user_id, restoration_id, source_id),
  FOREIGN KEY (user_id, restoration_id, redemption_id) REFERENCES point_restorations(user_id, restoration_id, redemption_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (user_id, redemption_id, source_id) REFERENCES point_funding(user_id, redemption_id, source_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX point_restoration_splits_source_idx ON point_restoration_splits(user_id, source_id);
CREATE INDEX point_restoration_splits_funding_idx ON point_restoration_splits(user_id, redemption_id, source_id);
CREATE INDEX point_source_extensions_restoration_idx ON point_source_extensions(user_id, restoration_id);

CREATE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp()::timestamptz(3)
$$;
-- Native PostgreSQL disambiguation: gaps use the pre-transition offset (shift
-- forward), overlaps use the post-transition offset (the later instant).
CREATE FUNCTION point_extension_deadline(opened_at timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT ((opened_at AT TIME ZONE 'Europe/Kyiv') + interval '30 days') AT TIME ZONE 'Europe/Kyiv'
$$;

CREATE OR REPLACE FUNCTION point_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable_fields text[];
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'point allocation facts are immutable'; END IF;
  IF TG_TABLE_NAME = 'point_sources' THEN
    mutable_fields := ARRAY['remaining', 'extended_remaining'];
    IF pg_trigger_depth() > 1 THEN
      mutable_fields := mutable_fields || ARRAY['spent', 'restored', 'extended_spent', 'extended_restored'];
    END IF;
  ELSIF TG_TABLE_NAME = 'point_redemptions' AND pg_trigger_depth() > 1 THEN
    mutable_fields := ARRAY['funded'];
  ELSIF TG_TABLE_NAME = 'point_restorations' AND pg_trigger_depth() > 1 THEN
    mutable_fields := ARRAY['credited'];
  ELSE
    RAISE EXCEPTION 'point allocation facts are immutable';
  END IF;
  IF (to_jsonb(NEW) - mutable_fields) IS DISTINCT FROM (to_jsonb(OLD) - mutable_fields) THEN
    RAISE EXCEPTION 'point allocation facts are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_sources_immutable BEFORE UPDATE OR DELETE ON point_sources FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();
CREATE TRIGGER point_restorations_immutable BEFORE UPDATE OR DELETE ON point_restorations FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();
CREATE TRIGGER point_source_extensions_immutable BEFORE UPDATE OR DELETE ON point_source_extensions FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();
CREATE TRIGGER point_restoration_splits_immutable BEFORE UPDATE OR DELETE ON point_restoration_splits FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();

CREATE FUNCTION point_source_initial_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.spent <> 0 OR NEW.restored <> 0 OR NEW.extended_spent <> 0 OR NEW.extended_restored <> 0 OR NEW.extended_remaining <> 0 THEN
    RAISE EXCEPTION 'initial source totals must be zero';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_source_initial_totals BEFORE INSERT ON point_sources FOR EACH ROW EXECUTE FUNCTION point_source_initial_totals();
CREATE FUNCTION point_restoration_initial_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credited <> 0 THEN RAISE EXCEPTION 'initial restoration total must be zero'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_restoration_initial_total BEFORE INSERT ON point_restorations FOR EACH ROW EXECUTE FUNCTION point_restoration_initial_total();

CREATE OR REPLACE FUNCTION point_funding_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE point_sources SET spent = spent + NEW.amount::bigint,
    extended_spent = extended_spent + NEW.extended_amount::bigint
    WHERE user_id = NEW.user_id AND source_id = NEW.source_id;
  UPDATE point_redemptions SET funded = funded + NEW.amount
    WHERE user_id = NEW.user_id AND redemption_id = NEW.redemption_id;
  RETURN NULL;
END $$;
CREATE FUNCTION point_restoration_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE after_expiry boolean;
BEGIN
  SELECT r.restored_at >= s.original_expires_at INTO after_expiry
    FROM point_restorations r JOIN point_sources s ON s.user_id = r.user_id
    WHERE r.user_id = NEW.user_id AND r.restoration_id = NEW.restoration_id AND s.source_id = NEW.source_id;
  UPDATE point_sources SET restored = restored + NEW.amount::bigint,
    extended_restored = extended_restored + CASE WHEN after_expiry THEN NEW.amount::bigint ELSE 0 END
    WHERE user_id = NEW.user_id AND source_id = NEW.source_id;
  UPDATE point_restorations SET credited = credited + NEW.amount
    WHERE user_id = NEW.user_id AND restoration_id = NEW.restoration_id;
  RETURN NULL;
END $$;
CREATE TRIGGER point_restoration_total AFTER INSERT ON point_restoration_splits FOR EACH ROW EXECUTE FUNCTION point_restoration_total();

-- Constant-time conservation per changed row; cumulative counters are bigint
-- because spend/restore cycles may exceed int32 even for one bounded source.
CREATE OR REPLACE FUNCTION point_allocation_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'point_sources' THEN
    IF EXISTS (SELECT 1 FROM point_sources s WHERE s.user_id = NEW.user_id AND s.source_id = NEW.source_id
      AND (s.remaining::bigint + s.spent <> s.granted::bigint + s.restored
        OR s.extended_remaining::bigint + s.extended_spent <> s.extended_restored)) THEN
      RAISE EXCEPTION 'point source conservation violated';
    END IF;
  ELSIF TG_TABLE_NAME = 'point_redemptions' THEN
    IF EXISTS (SELECT 1 FROM point_redemptions r WHERE r.user_id = NEW.user_id AND r.redemption_id = NEW.redemption_id AND r.amount <> r.funded) THEN
      RAISE EXCEPTION 'point redemption funding violated';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM point_sources s JOIN point_redemptions r ON r.user_id = s.user_id
      LEFT JOIN point_source_extensions e ON e.user_id = s.user_id AND e.source_id = s.source_id
      WHERE s.user_id = NEW.user_id AND s.source_id = NEW.source_id AND r.redemption_id = NEW.redemption_id
        AND r.spent_at >= s.issued_at
        AND ((r.spent_at < s.original_expires_at AND NEW.extended_amount = 0)
          OR (r.spent_at >= s.original_expires_at AND NEW.extended_amount = NEW.amount AND r.spent_at >= e.opened_at AND r.spent_at < e.expires_at))
    ) THEN RAISE EXCEPTION 'point funding outside source validity'; END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION point_restoration_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'point_restorations' THEN
    IF EXISTS (SELECT 1 FROM point_restorations h JOIN point_redemptions r USING (user_id, redemption_id)
      WHERE h.user_id = NEW.user_id AND h.restoration_id = NEW.restoration_id
        AND (h.amount <> h.credited OR h.amount <> r.amount OR h.restored_at < r.spent_at)) THEN
      RAISE EXCEPTION 'point restoration must fully match redemption';
    END IF;
  ELSIF TG_TABLE_NAME = 'point_restoration_splits' THEN
    IF NOT EXISTS (
      SELECT 1 FROM point_funding f JOIN point_sources s USING (user_id, source_id)
      JOIN point_restorations h ON h.user_id = f.user_id AND h.redemption_id = f.redemption_id
      LEFT JOIN point_source_extensions e ON e.user_id = s.user_id AND e.source_id = s.source_id
      WHERE f.user_id = NEW.user_id AND f.redemption_id = NEW.redemption_id AND f.source_id = NEW.source_id
        AND h.restoration_id = NEW.restoration_id AND f.amount = NEW.amount
        AND (h.restored_at < s.original_expires_at OR h.restored_at >= e.opened_at)
        AND NEW.expires_at = CASE WHEN h.restored_at < s.original_expires_at THEN s.original_expires_at ELSE e.expires_at END
    ) THEN RAISE EXCEPTION 'point restoration split mismatch'; END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM point_restoration_splits p JOIN point_restorations h USING (user_id, restoration_id, redemption_id)
      JOIN point_sources s ON s.user_id = p.user_id AND s.source_id = p.source_id
      WHERE p.user_id = NEW.user_id AND p.source_id = NEW.source_id AND p.restoration_id = NEW.restoration_id
        AND h.restored_at = NEW.opened_at AND NEW.opened_at >= s.original_expires_at
        AND NEW.expires_at = point_extension_deadline(NEW.opened_at)
    ) THEN RAISE EXCEPTION 'point extension must originate from post-expiry restoration'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER point_restorations_integrity AFTER INSERT OR UPDATE ON point_restorations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_restoration_integrity();
CREATE CONSTRAINT TRIGGER point_restoration_splits_integrity AFTER INSERT ON point_restoration_splits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_restoration_integrity();
CREATE CONSTRAINT TRIGGER point_source_extensions_integrity AFTER INSERT ON point_source_extensions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_restoration_integrity();

COMMIT;
