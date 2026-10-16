-- Step 4: profiles/resume, jobs & applications, reviews, advertisements

ALTER TABLE profiles
  ADD COLUMN headline TEXT,
  ADD COLUMN availability TEXT NOT NULL DEFAULT 'open' CHECK (availability IN ('available','open','unavailable')),
  ADD COLUMN slug CITEXT UNIQUE,
  ADD COLUMN resume_url TEXT;

CREATE TABLE user_skills (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name CITEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  PRIMARY KEY (user_id, name)
);

CREATE TABLE work_experience (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company TEXT NOT NULL CHECK (char_length(company) BETWEEN 1 AND 160),
  role TEXT NOT NULL CHECK (char_length(role) BETWEEN 1 AND 160),
  start_date DATE NOT NULL,
  end_date DATE,
  responsibilities TEXT, achievements TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_work_experience_user ON work_experience(user_id, start_date DESC);

CREATE TABLE education (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution TEXT NOT NULL CHECK (char_length(institution) BETWEEN 1 AND 160),
  degree TEXT, field_of_study TEXT,
  start_year INT CHECK (start_year BETWEEN 1950 AND 2100),
  end_year INT CHECK (end_year BETWEEN 1950 AND 2100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_year IS NULL OR start_year IS NULL OR end_year >= start_year)
);
CREATE INDEX idx_education_user ON education(user_id);

CREATE TABLE certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  issuer TEXT, issued_on DATE, expires_on DATE, url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX idx_certifications_user ON certifications(user_id);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description TEXT, url TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_user ON projects(user_id);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL,
  requirements TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  pay_min NUMERIC(12,2) CHECK (pay_min >= 0),
  pay_max NUMERIC(12,2) CHECK (pay_max >= 0),
  pay_period TEXT CHECK (pay_period IN ('hour','day','week','month','year','fixed')),
  currency TEXT NOT NULL DEFAULT 'INR',
  location TEXT,
  is_remote BOOLEAN NOT NULL DEFAULT false,
  work_type TEXT NOT NULL CHECK (work_type IN ('full_time','part_time','contract','temporary','internship','freelance')),
  deadline DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (pay_max IS NULL OR pay_min IS NULL OR pay_max >= pay_min)
);
CREATE INDEX idx_jobs_business ON jobs(business_id, status);
CREATE INDEX idx_jobs_open ON jobs(status, published_at DESC) WHERE status = 'open';

CREATE TABLE applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  cover_letter TEXT,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','shortlisted','interview','selected','rejected','withdrawn')),
  interview_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, user_id)
);
CREATE INDEX idx_applications_user ON applications(user_id, created_at DESC);
CREATE INDEX idx_applications_job ON applications(job_id, status);

CREATE TABLE application_events (
  id BIGSERIAL PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_application_events ON application_events(application_id, id);

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('business','individual')),
  subject_business_id UUID REFERENCES businesses(id),
  subject_user_id UUID REFERENCES users(id),
  relationship TEXT NOT NULL CHECK (relationship IN ('employee','applicant','buyer','employer','hirer')),
  context_business_id UUID REFERENCES businesses(id),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT CHECK (char_length(body) <= 2000),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  hidden_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((subject_type='business' AND subject_business_id IS NOT NULL AND subject_user_id IS NULL)
      OR (subject_type='individual' AND subject_user_id IS NOT NULL AND subject_business_id IS NULL))
);
-- One review per reviewer per subject (fraud/duplicate protection enforced by the database)
CREATE UNIQUE INDEX uq_reviews_business ON reviews(reviewer_id, subject_business_id) WHERE subject_business_id IS NOT NULL;
CREATE UNIQUE INDEX uq_reviews_user ON reviews(reviewer_id, subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX idx_reviews_business ON reviews(subject_business_id, status, created_at DESC);
CREATE INDEX idx_reviews_user ON reviews(subject_user_id, status, created_at DESC);
CREATE INDEX idx_reviews_reviewer_day ON reviews(reviewer_id, created_at);

CREATE TABLE review_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id, reporter_id)
);
CREATE INDEX idx_review_reports_open ON review_reports(status, created_at) WHERE status = 'open';

CREATE TABLE advertisements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description TEXT CHECK (char_length(description) <= 500),
  image_url TEXT,
  cta_label TEXT CHECK (char_length(cta_label) <= 30),
  cta_url TEXT CHECK (cta_url ~* '^https?://'),
  placements TEXT[] NOT NULL CHECK (cardinality(placements) > 0 AND placements <@ ARRAY['discover','business_profile','product_discovery']::text[]),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  moderation_status TEXT NOT NULL DEFAULT 'approved' CHECK (moderation_status IN ('approved','rejected')),
  moderation_note TEXT,
  tier TEXT NOT NULL DEFAULT 'free',            -- hook for paid placements later
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_ads_business ON advertisements(business_id);
CREATE INDEX idx_ads_live ON advertisements(status, moderation_status, start_date, end_date);
