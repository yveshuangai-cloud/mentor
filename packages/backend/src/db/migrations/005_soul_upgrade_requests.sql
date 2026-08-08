CREATE TABLE IF NOT EXISTS soul_upgrade_requests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'planned', 'approved', 'in_progress', 'completed', 'rejected')),
  source TEXT NOT NULL DEFAULT 'line',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_soul_upgrade_requests_status_created
  ON soul_upgrade_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_soul_upgrade_requests_tenant
  ON soul_upgrade_requests(tenant_id, created_at DESC);
