ALTER TABLE packing_lists ADD COLUMN departure_time text CHECK(departure_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
