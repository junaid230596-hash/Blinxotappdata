-- Blinxot foundation schema
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  account_type TEXT NOT NULL CHECK (account_type IN ('individual','business_owner','employee','supplier','super_admin')),
  email_verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hashed single-use tokens (email verification, password reset)
CREATE TABLE user_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id, purpose);

-- Refresh sessions (rotating, revocable)
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT,
  bio TEXT,
  avatar_url TEXT,
  city TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  logo_url TEXT,
  is_public BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_businesses_owner ON businesses(owner_id);

-- RBAC
CREATE TABLE permissions (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE, -- NULL = system role
  name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (business_id, name)
);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE business_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
CREATE INDEX idx_members_user ON business_members(user_id);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_business ON audit_logs(business_id, created_at DESC);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed permission catalogue
INSERT INTO permissions (key, description) VALUES
  ('business.manage','Edit business settings'),
  ('members.view','View business members'),
  ('members.manage','Invite/remove members and change roles'),
  ('employees.view','View employees'),
  ('employees.create','Create employees'),
  ('employees.edit','Edit employees'),
  ('employees.delete','Remove employees'),
  ('attendance.view','View all attendance'),
  ('attendance.manage','Edit attendance records'),
  ('salary.view','View salary records'),
  ('salary.manage','Manage salary configuration and records'),
  ('tasks.view','View tasks'),
  ('tasks.manage','Create/assign tasks'),
  ('inventory.view','View inventory'),
  ('inventory.manage','Adjust stock'),
  ('products.view','View products'),
  ('products.manage','Manage products'),
  ('purchases.view','View purchases'),
  ('purchases.manage','Manage purchases'),
  ('orders.view','View orders'),
  ('orders.create','Create orders'),
  ('orders.manage','Manage order status'),
  ('customers.view','View customers'),
  ('customers.manage','Manage customers'),
  ('crm.view','View CRM'),
  ('crm.manage','Manage CRM'),
  ('jobs.manage','Publish jobs and review applicants'),
  ('ads.manage','Manage advertisements'),
  ('reports.view','View reports'),
  ('audit.view','View business audit log');

-- System roles (business_id NULL, cloned per business on creation)
INSERT INTO roles (name, is_system) VALUES
  ('Business Owner', true), ('Business Admin', true), ('Manager', true), ('Employee', true);

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p WHERE r.name = 'Business Owner' AND r.business_id IS NULL;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Business Admin' AND r.business_id IS NULL AND p.key <> 'business.manage';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Manager' AND r.business_id IS NULL
  AND p.key IN ('members.view','employees.view','attendance.view','attendance.manage','tasks.view','tasks.manage',
                'inventory.view','inventory.manage','products.view','products.manage','purchases.view','purchases.manage',
                'orders.view','orders.create','orders.manage','customers.view','customers.manage','crm.view','crm.manage','reports.view');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Employee' AND r.business_id IS NULL AND p.key IN ('tasks.view','products.view','inventory.view');
