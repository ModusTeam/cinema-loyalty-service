CREATE TABLE point_sources (
  user_id uuid NOT NULL, source_id uuid NOT NULL, source_ref varchar(128) NOT NULL,
  granted integer NOT NULL CHECK (granted > 0),
  remaining integer NOT NULL CHECK (remaining >= 0 AND remaining <= granted),
  issued_at timestamptz(3) NOT NULL, original_expires_at timestamptz(3) NOT NULL,
  PRIMARY KEY (user_id, source_id), UNIQUE (user_id, source_ref),
  CHECK (length(source_ref) > 0), CHECK (original_expires_at > issued_at)
);
CREATE INDEX point_sources_user_id_original_expires_at_source_id_idx ON point_sources(user_id, original_expires_at, source_id);
CREATE TABLE point_redemptions (
  user_id uuid NOT NULL, redemption_id uuid NOT NULL, debit_ref uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0), spent_at timestamptz(3) NOT NULL,
  PRIMARY KEY (user_id, redemption_id), UNIQUE (user_id, debit_ref)
);
CREATE TABLE point_funding (
  user_id uuid NOT NULL, redemption_id uuid NOT NULL, source_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  PRIMARY KEY (user_id, redemption_id, source_id),
  FOREIGN KEY (user_id, source_id) REFERENCES point_sources(user_id, source_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (user_id, redemption_id) REFERENCES point_redemptions(user_id, redemption_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX point_funding_user_id_source_id_idx ON point_funding(user_id, source_id);

-- Original facts and funding records are append-only. Only source remaining changes.
CREATE FUNCTION point_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'point_sources' AND TG_OP = 'UPDATE' THEN
    IF ROW(NEW.user_id, NEW.source_id, NEW.source_ref, NEW.granted, NEW.issued_at, NEW.original_expires_at)
       IS NOT DISTINCT FROM ROW(OLD.user_id, OLD.source_id, OLD.source_ref, OLD.granted, OLD.issued_at, OLD.original_expires_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'point allocation facts are immutable';
END $$;
CREATE TRIGGER point_sources_immutable BEFORE UPDATE OR DELETE ON point_sources FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();
CREATE TRIGGER point_redemptions_immutable BEFORE UPDATE OR DELETE ON point_redemptions FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();
CREATE TRIGGER point_funding_immutable BEFORE UPDATE OR DELETE ON point_funding FOR EACH ROW EXECUTE FUNCTION point_allocation_immutable();

-- Deferred checks allow the caller to write source, redemption and links in one
-- transaction, but never commit an incomplete allocation or a mismatched sum.
CREATE FUNCTION point_allocation_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
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
    AND COALESCE((SELECT sum(f.amount::bigint) FROM point_funding f WHERE f.user_id = u AND f.redemption_id = r), 0) <> p.amount::bigint
  ) THEN RAISE EXCEPTION 'point redemption funding violated'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER point_sources_conservation AFTER INSERT OR UPDATE ON point_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_allocation_conservation();
CREATE CONSTRAINT TRIGGER point_redemptions_conservation AFTER INSERT ON point_redemptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_allocation_conservation();
CREATE CONSTRAINT TRIGGER point_funding_conservation AFTER INSERT ON point_funding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION point_allocation_conservation();
