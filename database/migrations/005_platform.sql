-- Step 5: plans & limits, platform admin, leave, performance reviews, employee documents
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- new permissions, granted to existing roles (templates and per-business clones) ----------
INSERT INTO permissions (key, description) VALUES
  ('leave.view','View leave requests'),
  ('leave.manage','Approve or reject leave'),
  ('performance.view','View performance reviews'),
  ('performance.manage','Write and share performance reviews'),
  ('documents.view','View employee documents'),
  ('documents.manage','Upload and delete employee documents');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY['leave.view','leave.manage','performance.view','performance.manage','documents.view','documents.manage']) AS k
 WHERE r.name IN ('Business Owner','Business Admin');
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY['leave.view','leave.manage','performance.view','performance.manage','documents.view']) AS k
 WHERE r.name = 'Manager';

-- ---------- subscription plans ----------
CREATE TABLE plans (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_monthly NUMERIC(10,2),                    -- NULL = contact sales
  currency TEXT NOT NULL DEFAULT 'INR',
  limits JSONB NOT NULL DEFAULT '{}',             -- missing key = unlimited
  is_public BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0
);
INSERT INTO plans (key, name, price_monthly, limits, sort_order) VALUES
  ('free','Free',0,'{"members":5,"products":50,"ordersPerMonth":100,"businesses":1,"storageMb":50}',1),
  ('starter','Starter',999,'{"members":25,"products":1000,"ordersPerMonth":2000,"businesses":2,"storageMb":1024}',2),
  ('pro','Pro',2999,'{"members":100,"products":20000,"ordersPerMonth":20000,"businesses":5,"storageMb":10240}',3),
  ('enterprise','Enterprise',NULL,'{}',4);

CREATE TABLE subscriptions (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL REFERENCES plans(key),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','cancelled')),
  current_period_end TIMESTAMPTZ,
  provider TEXT, provider_ref TEXT,               -- payment-gateway hook (Razorpay/Stripe/...)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO subscriptions (business_id, plan_key) SELECT id, 'free' FROM businesses;

-- Tracks stored bytes per business so the storage limit is enforceable.
CREATE TABLE stored_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  file_key TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  is_private BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stored_files_business ON stored_files(business_id);

CREATE TABLE platform_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('business','product')),
  name CITEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  UNIQUE (kind, name)
);

-- ---------- leave ----------
CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('casual','sick','paid','unpaid','other')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days INT NOT NULL CHECK (days BETWEEN 1 AND 90),
  reason TEXT CHECK (char_length(reason) <= 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT, decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  -- An employee can never hold two live (pending/approved) leaves covering the same day.
  EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status IN ('pending','approved'))
);
CREATE INDEX idx_leave_business ON leave_requests(business_id, status, start_date DESC);

-- ---------- performance reviews ----------
CREATE TABLE performance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  period_start DATE NOT NULL, period_end DATE NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  strengths TEXT, improvements TEXT, goals TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared')),
  shared_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX idx_perf_employee ON performance_reviews(employee_id, period_end DESC);

-- ---------- employee documents (private files) ----------
CREATE TABLE employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  category TEXT NOT NULL CHECK (category IN ('contract','id_proof','certificate','payslip','other')),
  file_key TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL, bytes BIGINT NOT NULL,
  expiry_date DATE,
  visible_to_employee BOOLEAN NOT NULL DEFAULT false,
  stored_file_id UUID REFERENCES stored_files(id) ON DELETE SET NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_docs ON employee_documents(employee_id, created_at DESC);
