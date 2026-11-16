CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wechat_openid text UNIQUE NOT NULL,
  nickname text NOT NULL DEFAULT '新成员', avatar_asset_id uuid, city_code text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai', preferences jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleting')),
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE registrations (token_hash text PRIMARY KEY, wechat_openid text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
  consumed_by uuid REFERENCES users(id) ON DELETE SET NULL, consumed_at timestamptz
);
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 30), sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id), UNIQUE(user_id,name)
);
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('occasion','style')), name text NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  sort_order integer NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1, UNIQUE(user_id,id), UNIQUE(user_id,kind,name)
);
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('original','cutout','thumbnail','outfit-cover','body-photo','generated','export')),
  storage_key text UNIQUE NOT NULL, mime_type text NOT NULL, width integer NOT NULL, height integer NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0), parent_asset_id uuid,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('temporary','ready','deleting')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY(user_id,parent_asset_id) REFERENCES media_assets(user_id,id)
);
CREATE INDEX media_parent ON media_assets(user_id,parent_asset_id);
ALTER TABLE users ADD CONSTRAINT users_avatar_owner FOREIGN KEY(id,avatar_asset_id) REFERENCES media_assets(user_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE clothes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id uuid, name text NOT NULL CHECK (length(name) <= 60), primary_asset_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','active','archived')), colors text[] NOT NULL DEFAULT '{}', seasons text[] NOT NULL DEFAULT '{}',
  brand text NOT NULL DEFAULT '', size_label text NOT NULL DEFAULT '', material text NOT NULL DEFAULT '',
  price_cents bigint CHECK (price_cents >= 0), purchased_on date, notes text NOT NULL DEFAULT '', favorite boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), CHECK (status <> 'active' OR category_id IS NOT NULL),
  CHECK (colors <@ ARRAY['white','black','gray','cream','brown','blue','green','red','pink','yellow','purple','orange','multi']::text[]),
  CHECK (seasons <@ ARRAY['spring','summer','autumn','winter','all']::text[]),
  FOREIGN KEY(user_id,category_id) REFERENCES categories(user_id,id),
  FOREIGN KEY(user_id,primary_asset_id) REFERENCES media_assets(user_id,id)
);
CREATE INDEX clothes_list ON clothes(user_id,status,created_at DESC,id DESC);
CREATE TABLE clothing_assets (
  user_id uuid NOT NULL, clothing_id uuid NOT NULL, asset_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('primary','detail')), sort_order integer NOT NULL,
  PRIMARY KEY(user_id,clothing_id,asset_id), FOREIGN KEY(user_id,clothing_id) REFERENCES clothes(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,asset_id) REFERENCES media_assets(user_id,id)
);
CREATE TABLE clothing_tags (
  user_id uuid NOT NULL, clothing_id uuid NOT NULL, tag_id uuid NOT NULL, PRIMARY KEY(user_id,clothing_id,tag_id),
  FOREIGN KEY(user_id,clothing_id) REFERENCES clothes(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,tag_id) REFERENCES tags(user_id,id) ON DELETE CASCADE
);
CREATE TABLE outfits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, occasion text NOT NULL DEFAULT '', seasons text[] NOT NULL DEFAULT '{}', notes text NOT NULL DEFAULT '',
  favorite boolean NOT NULL DEFAULT false, background_color text NOT NULL, cover_asset_id uuid,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), FOREIGN KEY(user_id,cover_asset_id) REFERENCES media_assets(user_id,id)
);
CREATE INDEX outfits_list ON outfits(user_id,created_at DESC,id DESC);
CREATE TABLE outfit_items (
  user_id uuid NOT NULL, outfit_id uuid NOT NULL, clothing_id uuid NOT NULL,
  x double precision NOT NULL CHECK(x BETWEEN 0 AND 1), y double precision NOT NULL CHECK(y BETWEEN 0 AND 1),
  width double precision NOT NULL CHECK(width > 0 AND width <= 1), height double precision NOT NULL CHECK(height > 0 AND height <= 1),
  rotation double precision NOT NULL CHECK(rotation BETWEEN -180 AND 180), z_index integer NOT NULL,
  PRIMARY KEY(user_id,outfit_id,clothing_id), FOREIGN KEY(user_id,outfit_id) REFERENCES outfits(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,clothing_id) REFERENCES clothes(user_id,id)
);
CREATE TABLE wear_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worn_on date NOT NULL, occasion text NOT NULL DEFAULT '', source_outfit_id uuid, notes text NOT NULL DEFAULT '', body_asset_id uuid,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY(user_id,source_outfit_id) REFERENCES outfits(user_id,id) ON DELETE SET NULL(source_outfit_id),
  FOREIGN KEY(user_id,body_asset_id) REFERENCES media_assets(user_id,id)
);
CREATE INDEX wear_dates ON wear_records(user_id,worn_on);
CREATE TABLE wear_items (
  user_id uuid NOT NULL, wear_record_id uuid NOT NULL, clothing_id uuid NOT NULL, name_snapshot text NOT NULL, category_snapshot text NOT NULL,
  PRIMARY KEY(user_id,wear_record_id,clothing_id), FOREIGN KEY(user_id,wear_record_id) REFERENCES wear_records(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,clothing_id) REFERENCES clothes(user_id,id)
);
CREATE TABLE packing_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, start_on date, end_on date, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), CHECK(start_on IS NULL OR end_on IS NULL OR start_on <= end_on)
);
CREATE TABLE packing_items (
  user_id uuid NOT NULL, packing_list_id uuid NOT NULL, clothing_id uuid NOT NULL, packed boolean NOT NULL DEFAULT false, sort_order integer NOT NULL,
  PRIMARY KEY(user_id,packing_list_id,clothing_id), FOREIGN KEY(user_id,packing_list_id) REFERENCES packing_lists(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,clothing_id) REFERENCES clothes(user_id,id)
);
CREATE TABLE image_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_asset_id uuid, clothing_id uuid, outfit_id uuid, outfit_version integer,
  kind text NOT NULL CHECK(kind IN ('process','cutout','classify','outfit-cover')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')), phase text NOT NULL DEFAULT '等待处理',
  cancel_requested boolean NOT NULL DEFAULT false, lease_expires_at timestamptz, heartbeat_at timestamptz,
  model_revision text, attempt_of uuid REFERENCES image_jobs(id) ON DELETE SET NULL, result jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz, UNIQUE(user_id,id),
  CHECK((kind='outfit-cover' AND outfit_id IS NOT NULL AND outfit_version IS NOT NULL) OR (kind<>'outfit-cover' AND input_asset_id IS NOT NULL)),
  FOREIGN KEY(user_id,input_asset_id) REFERENCES media_assets(user_id,id),
  FOREIGN KEY(user_id,clothing_id) REFERENCES clothes(user_id,id) ON DELETE SET NULL(clothing_id),
  FOREIGN KEY(user_id,outfit_id) REFERENCES outfits(user_id,id) ON DELETE CASCADE
);
CREATE INDEX image_jobs_queue ON image_jobs(created_at,id) WHERE status='queued';
CREATE UNIQUE INDEX image_jobs_active_input ON image_jobs(user_id,input_asset_id,kind) WHERE status IN ('queued','running') AND input_asset_id IS NOT NULL;
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, route text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,route,request_key)
);
CREATE TABLE data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')), asset_id uuid, expires_at timestamptz,
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY(user_id,asset_id) REFERENCES media_assets(user_id,id)
);
CREATE TABLE external_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('recommendation','try-on')), status text NOT NULL,
  provider text NOT NULL, provider_job_id text, consent_at timestamptz NOT NULL, result jsonb,
  estimated_cents bigint NOT NULL CHECK(estimated_cents >= 0), settled_cents bigint CHECK(settled_cents >= 0),
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id), UNIQUE(provider,provider_job_id)
);
