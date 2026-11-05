-- Derived funding total avoids re-reading all splits for every deferred row.
ALTER TABLE point_redemptions ADD COLUMN funded integer NOT NULL DEFAULT 0;
-- Preserve any already committed dormant allocations without inventing sources.
DROP TRIGGER point_redemptions_immutable ON point_redemptions;
UPDATE point_redemptions r SET funded = COALESCE((SELECT sum(f.amount)::integer FROM point_funding f WHERE f.user_id = r.user_id AND f.redemption_id = r.redemption_id), 0);
ALTER TABLE point_redemptions ADD CONSTRAINT point_redemptions_funded_bounds CHECK (funded >= 0 AND funded <= amount);
CREATE OR REPLACE FUNCTION point_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'point_sources' AND TG_OP = 'UPDATE' THEN
    IF ROW(NEW.user_id, NEW.source_id, NEW.source_ref, NEW.granted, NEW.issued_at, NEW.original_expires_at)
       IS NOT DISTINCT FROM ROW(OLD.user_id, OLD.source_id, OLD.source_ref, OLD.granted, OLD.issued_at, OLD.original_expires_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'point_redemptions' AND TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    IF ROW(NEW.user_id, NEW.redemption_id, NEW.debit_ref, NEW.amount, NEW.spent_at)
       IS NOT DISTINCT FROM ROW(OLD.user_id, OLD.redemption_id, OLD.debit_ref, OLD.amount, OLD.spent_at) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'point allocation facts are immutable';
END $$;
CREATE TRIGGER point_redemptions_immutable BEFORE UPDATE OR DELETE ON point_redemptions FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();
CREATE FUNCTION point_redemption_initial_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.funded <> 0 THEN RAISE EXCEPTION 'initial funding total must be zero'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_redemption_initial_total BEFORE INSERT ON point_redemptions FOR EACH ROW EXECUTE FUNCTION point_redemption_initial_total();
CREATE FUNCTION point_funding_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE point_redemptions SET funded = funded + NEW.amount WHERE user_id = NEW.user_id AND redemption_id = NEW.redemption_id;
  RETURN NULL;
END $$;
CREATE TRIGGER point_funding_total AFTER INSERT ON point_funding FOR EACH ROW EXECUTE FUNCTION point_funding_total();
CREATE OR REPLACE FUNCTION point_allocation_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u uuid; s uuid; r uuid;
BEGIN
  u := NEW.user_id;
  IF TG_TABLE_NAME = 'point_sources' THEN s := NEW.source_id;
  ELSIF TG_TABLE_NAME = 'point_redemptions' THEN r := NEW.redemption_id;
  ELSE s := NEW.source_id; r := NEW.redemption_id;
  END IF;
  IF TG_TABLE_NAME = 'point_funding' THEN
    IF EXISTS (
    SELECT 1 FROM point_sources s JOIN point_redemptions r ON r.user_id = s.user_id
    WHERE s.user_id = NEW.user_id AND s.source_id = NEW.source_id AND r.redemption_id = NEW.redemption_id
      AND (r.spent_at < s.issued_at OR r.spent_at >= s.original_expires_at)
    ) THEN RAISE EXCEPTION 'point funding outside source validity'; END IF;
  END IF;
  IF s IS NOT NULL AND EXISTS (
    SELECT 1 FROM point_sources p WHERE p.user_id = u AND p.source_id = s
    AND p.remaining::bigint + COALESCE((SELECT sum(f.amount::bigint) FROM point_funding f WHERE f.user_id = u AND f.source_id = s), 0) <> p.granted::bigint
  ) THEN RAISE EXCEPTION 'point source conservation violated'; END IF;
  IF r IS NOT NULL AND EXISTS (
    SELECT 1 FROM point_redemptions p WHERE p.user_id = u AND p.redemption_id = r
    AND p.funded <> p.amount
  ) THEN RAISE EXCEPTION 'point redemption funding violated'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER point_redemptions_conservation ON point_redemptions;
CREATE CONSTRAINT TRIGGER point_redemptions_conservation AFTER INSERT OR UPDATE ON point_redemptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_allocation_conservation();
