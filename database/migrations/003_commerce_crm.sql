-- Step 3: products, inventory, suppliers, purchases, orders (+OTP, returns), customers, CRM

CREATE TABLE counters (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, key)
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name CITEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

-- Supplier records a business keeps; linked_business_id connects to a supplier on the platform.
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  contact_name TEXT, email TEXT, phone TEXT, address TEXT, notes TEXT,
  linked_business_id UUID REFERENCES businesses(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (linked_business_id IS NULL OR linked_business_id <> business_id)
);
CREATE UNIQUE INDEX uq_suppliers_link ON suppliers(business_id, linked_business_id) WHERE linked_business_id IS NOT NULL;
CREATE INDEX idx_suppliers_business ON suppliers(business_id);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  sku TEXT NOT NULL CHECK (char_length(sku) BETWEEN 1 AND 64),
  barcode TEXT,
  description TEXT,
  images JSONB NOT NULL DEFAULT '[]',
  cost_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  selling_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  unit TEXT NOT NULL DEFAULT 'pcs',
  -- Only ever modified by the inventory service, in the same transaction as a movement row.
  stock_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  min_stock NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  is_listed BOOLEAN NOT NULL DEFAULT false,  -- visible in the cross-business marketplace
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);
CREATE UNIQUE INDEX uq_products_barcode ON products(business_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_business ON products(business_id, status);
CREATE INDEX idx_products_name ON products(business_id, lower(name));
CREATE INDEX idx_products_listed ON products(is_listed, status) WHERE is_listed;

CREATE TABLE inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('opening','stock_in','stock_out','adjustment','purchase_receipt','sale','sale_cancel','sale_return','damaged')),
  quantity_delta NUMERIC(12,3) NOT NULL CHECK (quantity_delta <> 0),
  balance_after NUMERIC(12,3) NOT NULL CHECK (balance_after >= 0),
  unit_cost NUMERIC(12,2),
  ref_type TEXT, ref_id UUID, note TEXT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_movements_product ON inventory_movements(product_id, id DESC);
CREATE INDEX idx_movements_business ON inventory_movements(business_id, created_at DESC);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  phone TEXT, email TEXT, address TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  last_interaction_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_business ON customers(business_id, lower(name));

CREATE TABLE customer_communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('call','email','meeting','sms','note')),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comms_customer ON customer_communications(customer_id, created_at DESC);

CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,   -- buyer
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  po_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','partially_received','received','cancelled')),
  notes TEXT, expected_date DATE,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, po_number)
);
CREATE INDEX idx_purchases_business ON purchases(business_id, status, created_at DESC);

CREATE TABLE purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),            -- buyer's product that stock is received into
  supplier_product_id UUID REFERENCES products(id),   -- supplier's product (marketplace purchases)
  name TEXT NOT NULL, sku TEXT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
  received_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  CHECK (received_qty <= quantity)
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,   -- seller
  order_number TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id),
  buyer_business_id UUID REFERENCES businesses(id),
  purchase_id UUID UNIQUE REFERENCES purchases(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','processing','ready','dispatched','delivered','cancelled','returned')),
  requires_otp BOOLEAN NOT NULL DEFAULT true,
  stock_committed BOOLEAN NOT NULL DEFAULT false,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0, tax_total NUMERIC(12,2) NOT NULL DEFAULT 0, total NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT, delivery_address TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
  UNIQUE (business_id, order_number),
  CHECK (NOT (customer_id IS NOT NULL AND buyer_business_id IS NOT NULL))
);
CREATE INDEX idx_orders_business ON orders(business_id, status, created_at DESC);
CREATE INDEX idx_orders_buyer ON orders(buyer_business_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, sku TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_subtotal NUMERIC(12,2) NOT NULL, line_tax NUMERIC(12,2) NOT NULL, line_total NUMERIC(12,2) NOT NULL,
  returned_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  CHECK (returned_qty <= quantity)
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE order_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reason TEXT, refund_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE order_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  condition TEXT NOT NULL CHECK (condition IN ('resellable','damaged'))
);

-- Delivery/pickup OTPs: only a salted hash is stored; limited attempts; expiring; single-use.
CREATE TABLE order_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_otps_order ON order_otps(order_id, created_at DESC);

-- ---------- CRM ----------
CREATE TABLE crm_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  website TEXT, industry TEXT, phone TEXT, address TEXT, notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_companies ON crm_companies(business_id, lower(name));

CREATE TABLE crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  company_id UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  email TEXT, phone TEXT, job_title TEXT, notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_contacts ON crm_contacts(business_id, lower(name));

CREATE TABLE crm_pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name CITEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  position INT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  UNIQUE (business_id, name)
);

CREATE TABLE crm_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  stage_id UUID NOT NULL REFERENCES crm_pipeline_stages(id),
  contact_id UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  company_id UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  expected_close DATE, lost_reason TEXT, closed_at TIMESTAMPTZ,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_deals ON crm_deals(business_id, stage_id);

CREATE TABLE crm_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  email TEXT, phone TEXT, company_name TEXT, source TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','unqualified','converted')),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  converted_deal_id UUID REFERENCES crm_deals(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_leads ON crm_leads(business_id, status, created_at DESC);

-- Notes, calls, meetings, tasks and follow-ups with reminders, attached to any CRM entity.
CREATE TABLE crm_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('lead','contact','company','deal')),
  entity_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('note','call','email','meeting','task','follow_up')),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body TEXT,
  due_at TIMESTAMPTZ, done_at TIMESTAMPTZ, reminder_sent_at TIMESTAMPTZ,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_activities_entity ON crm_activities(business_id, entity_type, entity_id, created_at DESC);
CREATE INDEX idx_crm_activities_due ON crm_activities(due_at) WHERE done_at IS NULL AND due_at IS NOT NULL;
