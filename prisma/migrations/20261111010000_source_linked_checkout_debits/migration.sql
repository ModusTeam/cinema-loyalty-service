BEGIN;

-- Optional, explicit links only. Historic checkout rows and standalone source
-- accounting retain their original identities; no provenance is inferred.
ALTER TABLE point_redemptions
  ADD COLUMN checkout_debit_id uuid,
  ADD COLUMN command_event_id varchar(128),
  ADD CONSTRAINT point_redemptions_checkout_binding_pair CHECK
    ((checkout_debit_id IS NULL) = (command_event_id IS NULL)),
  ADD CONSTRAINT point_redemptions_checkout_debit_id_fkey FOREIGN KEY (checkout_debit_id)
    REFERENCES checkout_debits(debit_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT point_redemptions_command_event_id_fkey FOREIGN KEY (command_event_id)
    REFERENCES processed_events(event_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX point_redemptions_checkout_debit_id_key ON point_redemptions(checkout_debit_id);
CREATE UNIQUE INDEX point_redemptions_command_event_id_key ON point_redemptions(command_event_id);

CREATE FUNCTION point_checkout_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debit points_transactions%ROWTYPE; command processed_events%ROWTYPE;
BEGIN
  IF NEW.checkout_debit_id IS NULL THEN RETURN NEW; END IF;
  -- These row locks also serialize direct SQL edits of the referenced facts.
  SELECT p.* INTO debit FROM points_transactions p
    JOIN checkout_debits c ON c.debit_id = p.id
    WHERE c.debit_id = NEW.checkout_debit_id FOR SHARE OF p, c;
  SELECT * INTO command FROM processed_events
    WHERE event_id = NEW.command_event_id FOR SHARE;
  IF debit.id IS NULL OR command.event_id IS NULL
    OR NEW.debit_ref IS DISTINCT FROM debit.id
    OR NEW.user_id IS DISTINCT FROM debit.user_id
    OR debit.type IS DISTINCT FROM 'BURN_DISCOUNT'
    OR debit.points::bigint IS DISTINCT FROM -NEW.amount::bigint
    OR command.operation IS DISTINCT FROM 'DEDUCT'
    OR command.user_id IS DISTINCT FROM NEW.user_id
    OR command.order_id IS NULL OR command.order_id IS DISTINCT FROM debit.order_id
    OR command.amount IS DISTINCT FROM NEW.amount
    OR command.balance_after IS DISTINCT FROM debit.balance_after THEN
    RAISE EXCEPTION 'Checkout debit binding mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_checkout_binding_guard BEFORE INSERT ON point_redemptions
  FOR EACH ROW EXECUTE FUNCTION point_checkout_binding_guard();

-- PointRedemption's existing immutable trigger protects both optional links.
-- Keep linked legacy facts stable too; ordinary unbound writers are unchanged.
CREATE FUNCTION point_checkout_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM point_redemptions WHERE checkout_debit_id = OLD.id)
    AND (TG_OP = 'DELETE' OR ROW(NEW.id, NEW.user_id, NEW.type, NEW.points, NEW.balance_after, NEW.order_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.type, OLD.points, OLD.balance_after, OLD.order_id)) THEN
    RAISE EXCEPTION 'Linked checkout ledger facts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_checkout_ledger_guard BEFORE UPDATE OR DELETE ON points_transactions
  FOR EACH ROW EXECUTE FUNCTION point_checkout_ledger_guard();

CREATE FUNCTION point_checkout_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM point_redemptions WHERE command_event_id = OLD.event_id)
    AND (TG_OP = 'DELETE' OR ROW(NEW.event_id, NEW.operation, NEW.user_id, NEW.order_id, NEW.amount, NEW.balance_after)
      IS DISTINCT FROM ROW(OLD.event_id, OLD.operation, OLD.user_id, OLD.order_id, OLD.amount, OLD.balance_after)) THEN
    RAISE EXCEPTION 'Linked checkout command facts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_checkout_command_guard BEFORE UPDATE OR DELETE ON processed_events
  FOR EACH ROW EXECUTE FUNCTION point_checkout_command_guard();

COMMIT;
