-- GST-ready invoicing: seller GSTIN/state, HSN/SAC on products, buyer GSTIN/state, place of supply,
-- credit notes for returns, and invoice numbers that restart every financial year (April-March, India).

ALTER TABLE businesses
  ADD COLUMN legal_name TEXT,
  ADD COLUMN gstin TEXT,
  ADD COLUMN state_code TEXT,
  ADD CONSTRAINT businesses_gstin_fmt CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD CONSTRAINT businesses_state_fmt CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$');

ALTER TABLE products ADD COLUMN hsn_code TEXT, ADD CONSTRAINT products_hsn_fmt CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$');
ALTER TABLE order_items ADD COLUMN hsn_code TEXT;

ALTER TABLE customers
  ADD COLUMN gstin TEXT, ADD COLUMN state_code TEXT,
  ADD CONSTRAINT customers_gstin_fmt CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD CONSTRAINT customers_state_fmt CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$');

ALTER TABLE orders ADD COLUMN place_of_supply TEXT, ADD CONSTRAINT orders_pos_fmt CHECK (place_of_supply IS NULL OR place_of_supply ~ '^[0-9]{2}$');

-- Financial-year numbering: INV/26-27/000001 (16 characters: the GST limit). Counter per business per financial year.
-- Invoices issued before this migration keep their existing numbers (they are legal documents); formats differ so they can never collide.
CREATE OR REPLACE FUNCTION assign_fy_number() RETURNS trigger AS $$
DECLARE
  v_key TEXT := TG_ARGV[0]; v_prefix TEXT := TG_ARGV[1]; v_col TEXT := TG_ARGV[2]; v_date TEXT := TG_ARGV[3];
  d TIMESTAMP; start_year INT; fy TEXT; short TEXT; n BIGINT;
BEGIN
  IF COALESCE(to_jsonb(NEW)->>v_col, '') <> '' THEN RETURN NEW; END IF;
  d := (to_jsonb(NEW)->>v_date)::timestamptz AT TIME ZONE 'Asia/Kolkata';
  start_year := CASE WHEN extract(month FROM d) >= 4 THEN extract(year FROM d)::int ELSE extract(year FROM d)::int - 1 END;
  fy := start_year || '-' || lpad(((start_year + 1) % 100)::text, 2, '0');
  short := lpad((start_year % 100)::text, 2, '0') || '-' || lpad(((start_year + 1) % 100)::text, 2, '0');
  INSERT INTO counters (business_id, key, value) VALUES (NEW.business_id, v_key || '-' || fy, 1)
    ON CONFLICT (business_id, key) DO UPDATE SET value = counters.value + 1 RETURNING value INTO n;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(v_col, v_prefix || '/' || short || '/' || lpad(n::text, 6, '0')));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER trg_invoices_number ON invoices;
CREATE TRIGGER trg_invoices_number BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION assign_fy_number('invoice', 'INV', 'invoice_number', 'issued_at');

-- Credit notes: issued automatically when goods are returned against an invoiced order.
CREATE TABLE credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  return_id UUID NOT NULL UNIQUE REFERENCES order_returns(id) ON DELETE CASCADE,
  note_number TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  subtotal NUMERIC(12,2) NOT NULL, tax_total NUMERIC(12,2) NOT NULL, total NUMERIC(12,2) NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (business_id, note_number)
);
CREATE INDEX idx_credit_notes_invoice ON credit_notes (invoice_id);
CREATE TRIGGER trg_credit_notes_number BEFORE INSERT ON credit_notes FOR EACH ROW EXECUTE FUNCTION assign_fy_number('credit_note', 'CN', 'note_number', 'issued_at');
