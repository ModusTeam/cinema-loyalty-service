BEGIN;
ALTER TABLE point_restorations
  ADD COLUMN refund_ledger_id uuid UNIQUE REFERENCES points_transactions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN command_event_id varchar(128) UNIQUE REFERENCES processed_events(event_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT point_restorations_checkout_binding_pair CHECK ((refund_ledger_id IS NULL) = (command_event_id IS NULL));

CREATE FUNCTION point_checkout_refund_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refund points_transactions%ROWTYPE; debit points_transactions%ROWTYPE; command processed_events%ROWTYPE; original point_redemptions%ROWTYPE;
BEGIN
  IF NEW.refund_ledger_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO original FROM point_redemptions WHERE user_id=NEW.user_id AND redemption_id=NEW.redemption_id FOR SHARE;
  SELECT p.* INTO refund FROM points_transactions p JOIN checkout_debits c ON c.refund_id=p.id
    WHERE p.id=NEW.refund_ledger_id AND c.debit_id=original.checkout_debit_id FOR SHARE OF p,c;
  SELECT * INTO debit FROM points_transactions WHERE id=original.checkout_debit_id FOR SHARE;
  SELECT * INTO command FROM processed_events WHERE event_id=NEW.command_event_id FOR SHARE;
  IF original.checkout_debit_id IS NULL OR original.command_event_id IS NULL
    OR refund.id IS NULL OR debit.id IS NULL OR command.event_id IS NULL
    OR original.debit_ref IS DISTINCT FROM debit.id OR original.amount IS DISTINCT FROM NEW.amount
    OR refund.user_id IS DISTINCT FROM NEW.user_id OR debit.user_id IS DISTINCT FROM NEW.user_id
    OR debit.type IS DISTINCT FROM 'BURN_DISCOUNT' OR debit.points::bigint IS DISTINCT FROM -NEW.amount::bigint
    OR refund.type IS DISTINCT FROM 'REFUND' OR refund.points IS DISTINCT FROM NEW.amount
    OR debit.order_id IS NULL OR refund.order_id IS DISTINCT FROM debit.order_id
    OR command.operation IS DISTINCT FROM 'REFUND' OR command.user_id IS DISTINCT FROM NEW.user_id
    OR command.order_id IS DISTINCT FROM debit.order_id OR command.amount IS DISTINCT FROM NEW.amount
    OR command.balance_after IS DISTINCT FROM refund.balance_after THEN
    RAISE EXCEPTION 'Checkout refund binding mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_checkout_refund_binding_guard BEFORE INSERT ON point_restorations FOR EACH ROW EXECUTE FUNCTION point_checkout_refund_binding_guard();

CREATE OR REPLACE FUNCTION point_checkout_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM point_redemptions WHERE checkout_debit_id = OLD.id)
    OR EXISTS (SELECT 1 FROM point_restorations WHERE refund_ledger_id = OLD.id))
    AND (TG_OP = 'DELETE' OR ROW(NEW.id, NEW.user_id, NEW.type, NEW.points, NEW.balance_after, NEW.order_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.type, OLD.points, OLD.balance_after, OLD.order_id)) THEN
    RAISE EXCEPTION 'Linked checkout ledger facts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION point_checkout_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM point_redemptions WHERE command_event_id = OLD.event_id)
    OR EXISTS (SELECT 1 FROM point_restorations WHERE command_event_id = OLD.event_id))
    AND (TG_OP = 'DELETE' OR ROW(NEW.event_id, NEW.operation, NEW.user_id, NEW.order_id, NEW.amount, NEW.balance_after)
      IS DISTINCT FROM ROW(OLD.event_id, OLD.operation, OLD.user_id, OLD.order_id, OLD.amount, OLD.balance_after)) THEN
    RAISE EXCEPTION 'Linked checkout command facts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION point_checkout_refund_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM point_restorations h JOIN point_redemptions r USING(user_id,redemption_id)
    WHERE r.checkout_debit_id=OLD.debit_id AND h.refund_ledger_id IS NOT NULL)
    AND (TG_OP='DELETE' OR ROW(NEW.debit_id,NEW.refund_id) IS DISTINCT FROM ROW(OLD.debit_id,OLD.refund_id)) THEN
    RAISE EXCEPTION 'Linked checkout refund ownership is immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_checkout_refund_owner_guard BEFORE UPDATE OR DELETE ON checkout_debits FOR EACH ROW EXECUTE FUNCTION point_checkout_refund_owner_guard();
COMMIT;
