ALTER TABLE packing_lists ADD COLUMN ended_at timestamptz;
CREATE INDEX packing_lists_status ON packing_lists(user_id,ended_at,created_at DESC,id DESC);

CREATE TABLE packing_reminders (
  packing_list_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  timing text NOT NULL CHECK(timing IN ('day-before','departure-day')),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sending','sent','skipped','cancelled','failed','unknown')),
  error_code text,
  sent_at timestamptz,
  FOREIGN KEY(user_id,packing_list_id) REFERENCES packing_lists(user_id,id) ON DELETE CASCADE
);
CREATE INDEX packing_reminders_due ON packing_reminders(scheduled_at) WHERE status='scheduled';
