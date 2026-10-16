-- Step 2: employees, attendance, salary, tasks

CREATE TABLE business_settings (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  work_start TIME NOT NULL DEFAULT '09:30',
  work_end TIME NOT NULL DEFAULT '18:00',
  late_grace_minutes INT NOT NULL DEFAULT 10 CHECK (late_grace_minutes BETWEEN 0 AND 240),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  position TEXT,
  department TEXT,
  phone TEXT,
  joining_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
CREATE INDEX idx_employees_business ON employees(business_id, status);

-- Configurable work -> salary model, per employee
CREATE TABLE salary_configs (
  employee_id UUID PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('hourly','daily','monthly')),
  rate NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  standard_hours_per_day NUMERIC(4,2) NOT NULL DEFAULT 8 CHECK (standard_hours_per_day BETWEEN 1 AND 24),
  overtime_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier >= 1),
  standard_days_per_month INT NOT NULL DEFAULT 26 CHECK (standard_days_per_month BETWEEN 1 AND 31),
  late_penalty NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (late_penalty >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  punch_in TIMESTAMPTZ NOT NULL,
  punch_out TIMESTAMPTZ,
  minutes_worked INT,
  is_late BOOLEAN NOT NULL DEFAULT false,
  left_early BOOLEAN NOT NULL DEFAULT false,
  edited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (punch_out IS NULL OR punch_out > punch_in)
);
-- DB-level guarantee: at most one open session per employee (race-safe against double taps)
CREATE UNIQUE INDEX uq_attendance_open ON attendance(employee_id) WHERE punch_out IS NULL;
CREATE INDEX idx_attendance_biz_date ON attendance(business_id, work_date);
CREATE INDEX idx_attendance_emp_date ON attendance(employee_id, work_date);

CREATE TABLE salary_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  method TEXT NOT NULL,
  hours_worked NUMERIC(8,2) NOT NULL,
  days_worked NUMERIC(6,1) NOT NULL,
  overtime_hours NUMERIC(8,2) NOT NULL,
  late_count INT NOT NULL,
  base_pay NUMERIC(12,2) NOT NULL,
  overtime_pay NUMERIC(12,2) NOT NULL,
  bonus NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  deductions NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  late_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(12,2) NOT NULL CHECK (net_pay >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','paid')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (employee_id, period_start, period_end)
);
CREATE INDEX idx_salary_business ON salary_records(business_id, period_start DESC);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description TEXT,
  assigned_to UUID REFERENCES users(id),
  created_by UUID NOT NULL REFERENCES users(id),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','review','completed','cancelled')),
  due_date DATE,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_business_status ON tasks(business_id, status, due_date);
CREATE INDEX idx_tasks_assignee ON tasks(assigned_to, status);

CREATE TABLE task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);

CREATE TABLE task_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (url LIKE '/uploads/%'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  uploaded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE task_activity (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at);
