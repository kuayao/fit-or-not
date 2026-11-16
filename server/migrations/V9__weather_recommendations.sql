-- 新建每日推荐缓存；不修改现有衣物、搭配或穿着记录。
CREATE TABLE weather_recommendations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weather_date date NOT NULL,
  city_code text NOT NULL CHECK (city_code ~ '^[0-9]{6}$'),
  wardrobe_key text NOT NULL,
  weather_conditions jsonb NOT NULL,
  result jsonb NOT NULL,
  generated_at timestamptz NOT NULL,
  UNIQUE (user_id, weather_date, city_code)
);
