/**
 * db.ts — D1 クエリヘルパー
 */

import type { SessionRow, SessionSummary, GuildSummary, ChannelSummary, ParticipantRow, TrackRow, SessionInsert, ParticipantInsert, TrackInsert } from './types.ts';

export async function getRequiredRole(db: D1Database, guildId: string) {
  const row = await db
    .prepare('SELECT required_role_id FROM guild_config WHERE guild_id = ?')
    .bind(guildId)
    .first<{ required_role_id: string | null }>();
  return row?.required_role_id ?? null;
}

export async function setRequiredRole(db: D1Database, guildId: string, roleId: string) {
  await db
    .prepare(
      `INSERT INTO guild_config (guild_id, required_role_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET required_role_id = excluded.required_role_id, updated_at = excluded.updated_at`,
    )
    .bind(guildId, roleId, Date.now())
    .run();
}

/** 録音が存在するギルドID一覧(録音数つき)。 */
export async function listGuildsWithSessions(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT guild_id, COUNT(*) AS session_count, MAX(started_at) AS last_at
       FROM sessions GROUP BY guild_id ORDER BY last_at DESC`,
    )
    .all<GuildSummary>();
  return results ?? [];
}

/** ギルド内の VC(チャンネル)一覧。録音数と最新時刻つき。 */
export async function listChannels(db: D1Database, guildId: string) {
  const { results } = await db
    .prepare(
      `SELECT channel_id,
              MAX(channel_name) AS channel_name,
              COUNT(*) AS session_count,
              MAX(started_at) AS last_at
       FROM sessions WHERE guild_id = ?
       GROUP BY channel_id ORDER BY last_at DESC`,
    )
    .bind(guildId)
    .all<ChannelSummary>();
  return results ?? [];
}

/** ギルド内のセッション一覧。channelId 指定でそのVCに絞る。 */
export async function listSessions(db: D1Database, guildId: string, channelId: string | null = null, limit = 100) {
  const sql = channelId
    ? `SELECT id, guild_id, channel_id, channel_name, started_at, ended_at, status, language, engine
       FROM sessions WHERE guild_id = ? AND channel_id = ? ORDER BY started_at DESC LIMIT ?`
    : `SELECT id, guild_id, channel_id, channel_name, started_at, ended_at, status, language, engine
       FROM sessions WHERE guild_id = ? ORDER BY started_at DESC LIMIT ?`;
  const stmt = channelId
    ? db.prepare(sql).bind(guildId, channelId, limit)
    : db.prepare(sql).bind(guildId, limit);
  const { results } = await stmt.all<SessionSummary>();
  return results ?? [];
}

export async function getSession(db: D1Database, sessionId: string) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first<SessionRow>();
}

export async function getParticipants(db: D1Database, sessionId: string) {
  const { results } = await db
    .prepare('SELECT user_id, display_name, joined_at, left_at FROM participants WHERE session_id = ?')
    .bind(sessionId)
    .all<ParticipantRow>();
  return results ?? [];
}

export async function getTracks(db: D1Database, sessionId: string) {
  const { results } = await db
    .prepare('SELECT id, user_id, r2_key, duration_sec FROM tracks WHERE session_id = ?')
    .bind(sessionId)
    .all<TrackRow>();
  return results ?? [];
}

/** recorder からの取り込み: セッション・参加者・トラックをまとめて upsert。 */
export async function upsertSession(db: D1Database, s: SessionInsert) {
  await db
    .prepare(
      `INSERT INTO sessions
        (id, guild_id, channel_id, channel_name, started_by, started_at, ended_at, status, language, engine, transcript_key, transcript_json_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         channel_name=excluded.channel_name, status=excluded.status, ended_at=excluded.ended_at,
         language=excluded.language, engine=excluded.engine, transcript_key=excluded.transcript_key,
         transcript_json_key=excluded.transcript_json_key`,
    )
    .bind(
      s.id, s.guild_id, s.channel_id, s.channel_name ?? null, s.started_by ?? null, s.started_at ?? null,
      s.ended_at ?? null, s.status ?? 'done', s.language ?? 'ja', s.engine ?? null,
      s.transcript_key ?? null, s.transcript_json_key ?? null, Date.now(),
    )
    .run();
}

export async function insertParticipants(db: D1Database, sessionId: string, participants: ParticipantInsert[]) {
  const stmt = db.prepare(
    `INSERT INTO participants (session_id, user_id, display_name, joined_at, left_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(session_id, user_id) DO UPDATE SET
       display_name=excluded.display_name, joined_at=excluded.joined_at, left_at=excluded.left_at`,
  );
  const batch = participants.map((p) =>
    stmt.bind(sessionId, p.user_id, p.display_name ?? null, p.joined_at ?? null, p.left_at ?? null),
  );
  if (batch.length) await db.batch(batch);
}

export async function insertTracks(db: D1Database, sessionId: string, tracks: TrackInsert[]) {
  // r2_key/duration_sec は「新しい値が null なら既存値を残す」。
  // 音声は /ingest の meta 登録後に別途アップロードされるため、meta の再送で
  // アップロード済みの r2_key を null で潰さないようにする。
  const stmt = db.prepare(
    `INSERT INTO tracks (id, session_id, user_id, r2_key, duration_sec)
     VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       r2_key=COALESCE(excluded.r2_key, r2_key),
       duration_sec=COALESCE(excluded.duration_sec, duration_sec)`,
  );
  const batch = tracks.map((t) =>
    stmt.bind(`${sessionId}:${t.user_id}`, sessionId, t.user_id, t.r2_key ?? null, t.duration_sec ?? null),
  );
  if (batch.length) await db.batch(batch);
}
