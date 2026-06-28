-- Cloudflare D1 スキーマ
-- recorder が録音終了時に書き込み、web(WorkerのWebUI)が読み出す。

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  channel_name    TEXT,
  started_by      TEXT,
  started_at      INTEGER,        -- epoch ms
  ended_at        INTEGER,
  status          TEXT,           -- recording | processing | done | failed
  language        TEXT,
  engine          TEXT,
  transcript_key  TEXT,           -- R2 key: transcript.md
  transcript_json_key TEXT,       -- R2 key: transcript.json
  created_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_guild ON sessions(guild_id, started_at DESC);

CREATE TABLE IF NOT EXISTS participants (
  session_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  display_name TEXT,
  joined_at    INTEGER,
  left_at      INTEGER,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  r2_key       TEXT,            -- 音声ファイル(wav)の R2 key
  duration_sec INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tracks_session ON tracks(session_id);

-- ギルドごとの「閲覧を許可するロール」。/setup で設定。
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id         TEXT PRIMARY KEY,
  required_role_id TEXT,
  updated_at       INTEGER
);
