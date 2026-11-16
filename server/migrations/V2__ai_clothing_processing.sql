ALTER TABLE clothes
  ADD COLUMN item_type text CHECK (length(item_type) <= 30),
  ADD COLUMN color_description text CHECK (length(color_description) <= 30),
  ADD COLUMN pattern text CHECK (pattern IN ('solid','striped','checked','printed','color-block','other')),
  ADD COLUMN visible_features text[] NOT NULL DEFAULT '{}' CHECK (cardinality(visible_features) <= 5);

ALTER TABLE image_jobs ADD COLUMN processing_state jsonb NOT NULL DEFAULT '{}';
