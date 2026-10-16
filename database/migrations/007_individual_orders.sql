-- Individuals can buy from public businesses. An order now has at most ONE kind of buyer:
-- a walk-in customer record (seller's CRM), a buying business (purchase order), or an individual user.
ALTER TABLE orders
  ADD COLUMN buyer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN buyer_phone   TEXT;

DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%buyer_business_id%'
  LOOP EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c); END LOOP;
END $$;

ALTER TABLE orders ADD CONSTRAINT orders_single_buyer CHECK (num_nonnulls(customer_id, buyer_business_id, buyer_user_id) <= 1);
CREATE INDEX idx_orders_buyer_user ON orders (buyer_user_id, created_at DESC) WHERE buyer_user_id IS NOT NULL;
