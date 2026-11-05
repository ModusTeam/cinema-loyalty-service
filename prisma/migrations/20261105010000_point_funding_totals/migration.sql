-- Derived funding total avoids re-reading all splits for every deferred row.
ALTER TABLE point_redemptions ADD COLUMN funded integer NOT NULL DEFAULT 0;
-- Preserve any already committed dormant allocations without inventing sources.
DROP TRIGGER point_redemptions_immutable ON point_redemptions;
UPDATE point_redemptions r SET funded = COALESCE((SELECT sum(f.amount)::integer FROM point_funding f WHERE f.user_id = r.user_id AND f.redemption_id = r.redemption_id), 0) WHERE r.funded IS DISTINCT FROM COALESCE((SELECT sum(f.amount)::integer FROM point_funding f WHERE f.user_id = r.user_id AND f.redemption_id = r.redemption_id), 0);
ALTER TABLE point_redemptions ADD CONSTRAINT point_redemptions_funded_bounds CHECK (funded >= 0 AND funded <= amount);
CREATE OR REPLACE FUNCTION point_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    CASE TG_TABLE_NAME
      WHEN 'point_sources' THEN
        IF (to_jsonb(NEW) - 'remaining') = (to_jsonb(OLD) - 'remaining') THEN RETURN NEW; END IF;
      WHEN 'point_redemptions' THEN
        IF pg_trigger_depth() > 1 AND (to_jsonb(NEW) - 'funded') = (to_jsonb(OLD) - 'funded') THEN RETURN NEW; END IF;
      ELSE NULL;
    END CASE;
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
DECLARE
  source_key uuid;
  redemption_key uuid;
  source_grant bigint;
  source_remaining bigint;
  source_spent bigint;
  debit_amount integer;
  debit_funded integer;
  valid_time boolean;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'point_sources' THEN source_key := NEW.source_id;
    WHEN 'point_redemptions' THEN redemption_key := NEW.redemption_id;
    ELSE source_key := NEW.source_id; redemption_key := NEW.redemption_id;
  END CASE;
  IF TG_TABLE_NAME = 'point_funding' THEN
    SELECT r.spent_at >= s.issued_at AND r.spent_at < s.original_expires_at INTO valid_time
      FROM point_sources s, point_redemptions r
      WHERE s.user_id = NEW.user_id AND s.source_id = source_key
        AND r.user_id = NEW.user_id AND r.redemption_id = redemption_key;
    IF valid_time IS DISTINCT FROM true THEN RAISE EXCEPTION 'point funding outside source validity'; END IF;
  END IF;
  IF source_key IS NOT NULL THEN
    SELECT granted, remaining INTO source_grant, source_remaining
      FROM point_sources WHERE user_id = NEW.user_id AND source_id = source_key;
    SELECT COALESCE(sum(amount::bigint), 0) INTO source_spent
      FROM point_funding WHERE user_id = NEW.user_id AND source_id = source_key;
    IF source_remaining + source_spent <> source_grant THEN RAISE EXCEPTION 'point source conservation violated'; END IF;
  END IF;
  IF redemption_key IS NOT NULL THEN
    SELECT amount, funded INTO debit_amount, debit_funded FROM point_redemptions
      WHERE user_id = NEW.user_id AND redemption_id = redemption_key;
    IF debit_amount <> debit_funded THEN RAISE EXCEPTION 'point redemption funding violated'; END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER point_redemptions_conservation ON point_redemptions;
CREATE CONSTRAINT TRIGGER point_redemptions_conservation AFTER INSERT OR UPDATE ON point_redemptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_allocation_conservation();
