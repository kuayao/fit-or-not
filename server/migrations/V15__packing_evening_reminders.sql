ALTER TABLE packing_lists ALTER COLUMN departure_time SET DEFAULT '07:00';
UPDATE packing_lists SET departure_time='07:00' WHERE departure_time IS NULL;

ALTER TABLE packing_reminders DROP CONSTRAINT packing_reminders_timing_check;
UPDATE packing_reminders SET timing='day-before' WHERE timing='departure-day';
ALTER TABLE packing_reminders ADD CONSTRAINT packing_reminders_timing_check CHECK(timing IN ('two-days-before','day-before'));
ALTER TABLE packing_reminders DROP CONSTRAINT packing_reminders_pkey;
ALTER TABLE packing_reminders ADD PRIMARY KEY(packing_list_id,timing);

UPDATE packing_reminders r
SET scheduled_at=(p.start_on-1+time '19:00') AT TIME ZONE 'Asia/Shanghai',
    status=CASE WHEN p.ended_at IS NULL AND (p.start_on-1+time '19:00') AT TIME ZONE 'Asia/Shanghai'>now() THEN 'scheduled' ELSE 'cancelled' END
FROM packing_lists p
WHERE p.user_id=r.user_id AND p.id=r.packing_list_id AND r.status='scheduled' AND p.start_on IS NOT NULL;
