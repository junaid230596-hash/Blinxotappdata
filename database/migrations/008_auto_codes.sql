-- Automatic, unique, human-readable numbers: SKU-000001, CUS-000001, EMP-000001, INV-000001 ...
-- One counter per business per kind (table `counters`). Assigned by a trigger so EVERY insert path gets one and
-- the sequence is atomic under concurrency. Generated values skip any value already taken (e.g. a hand-typed SKU).

CREATE OR REPLACE FUNCTION assign_code() RETURNS trigger AS $$
DECLARE
  v_col TEXT := TG_ARGV[2]; v_key TEXT := TG_ARGV[0]; v_prefix TEXT := TG_ARGV[1];
  candidate TEXT; taken INT; n BIGINT;
BEGIN
  IF COALESCE(to_jsonb(NEW)->>v_col, '') <> '' THEN RETURN NEW; END IF;      -- caller supplied one (e.g. a custom SKU)
  LOOP
    INSERT INTO counters (business_id, key, value) VALUES (NEW.business_id, v_key, 1)
      ON CONFLICT (business_id, key) DO UPDATE SET value = counters.value + 1 RETURNING value INTO n;
    candidate := v_prefix || '-' || lpad(n::text, 6, '0');
    EXECUTE format('SELECT count(*) FROM %I WHERE business_id = $1 AND %I = $2', TG_TABLE_NAME, v_col) INTO taken USING NEW.business_id, candidate;
    EXIT WHEN taken = 0;
  END LOOP;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(v_col, candidate));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Tables that gain a new `code` column (products already has `sku`; invoices are created below).
DO $$
DECLARE t RECORD; max_n BIGINT;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('customers','customer','CUS'), ('employees','employee','EMP'), ('suppliers','supplier','SUP'), ('tasks','task','TSK'),
      ('order_returns','return','RET'), ('salary_records','payslip','PAY'), ('crm_leads','lead','LEAD'), ('crm_deals','deal','DEAL'), ('jobs','job','JOB')
    ) AS x(tbl, key, prefix)
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN code TEXT', t.tbl);
    -- Number existing rows oldest-first, per business, then move the counter past them.
    EXECUTE format($f$
      UPDATE %1$I x SET code = %2$L || '-' || lpad(r.n::text, 6, '0')
        FROM (SELECT id, row_number() OVER (PARTITION BY business_id ORDER BY created_at, id) AS n FROM %1$I) r WHERE r.id = x.id$f$, t.tbl, t.prefix);
    EXECUTE format($f$
      INSERT INTO counters (business_id, key, value) SELECT business_id, %2$L, count(*) FROM %1$I GROUP BY business_id
        ON CONFLICT (business_id, key) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)$f$, t.tbl, t.key);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN code SET NOT NULL', t.tbl);
    EXECUTE format('CREATE UNIQUE INDEX %I ON %I (business_id, code)', 'uq_' || t.tbl || '_code', t.tbl);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION assign_code(%L, %L, %L)', 'trg_' || t.tbl || '_code', t.tbl, t.key, t.prefix, 'code');
  END LOOP;
END $$;

-- Products: the SKU itself is the code. Callers may leave it blank to get SKU-000001, SKU-000002, ...
-- Move the counter past any existing SKUs that already follow the pattern so new ones never collide.
INSERT INTO counters (business_id, key, value)
  SELECT business_id, 'product', max(substring(sku from '^SKU-(\d{1,15})$')::bigint) FROM products WHERE sku ~ '^SKU-\d{1,15}$' GROUP BY business_id
  ON CONFLICT (business_id, key) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value);
CREATE TRIGGER trg_products_sku BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION assign_code('product', 'SKU', 'sku');

-- Invoices: one per order, issued automatically when the seller accepts the order; voided (never deleted or renumbered) if the order is cancelled.
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  subtotal NUMERIC(12,2) NOT NULL, tax_total NUMERIC(12,2) NOT NULL, total NUMERIC(12,2) NOT NULL,
  snapshot JSONB NOT NULL,                      -- seller, buyer and lines exactly as issued; later edits to products or profiles never change it
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, invoice_number)
);
CREATE INDEX idx_invoices_business ON invoices (business_id, issued_at DESC);
CREATE TRIGGER trg_invoices_number BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION assign_code('invoice', 'INV', 'invoice_number');
