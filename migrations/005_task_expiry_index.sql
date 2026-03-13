CREATE INDEX IF NOT EXISTS idx_tasks_claimed_deadline
    ON tasks(status, deadline_at)
    WHERE status = 'claimed' AND deadline_at IS NOT NULL;
