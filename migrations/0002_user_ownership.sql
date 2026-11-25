-- Existing rows remain unassigned and are not visible to any authenticated user.
ALTER TABLE tasks ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_owner_updated ON tasks(owner_id, updated_at DESC);