-- Public business profile: opening hours and social links (spec section 5).
-- hours:   {"mon":{"open":"09:00","close":"18:00"},"sun":{"closed":true}, ...}  (validated by the API)
-- social:  {"facebook":"https://...","instagram":"https://..."}                 (http/https URLs only, validated by the API)
ALTER TABLE businesses
  ADD COLUMN business_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN social_links   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT businesses_hours_is_object CHECK (jsonb_typeof(business_hours) = 'object'),
  ADD CONSTRAINT businesses_social_is_object CHECK (jsonb_typeof(social_links) = 'object');

-- Sitemap / discovery queries filter on these.
CREATE INDEX idx_businesses_public ON businesses (updated_at DESC) WHERE is_public AND status = 'active';
