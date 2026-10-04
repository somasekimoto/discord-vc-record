// SELECT の投影。D1 の generic はランタイム検証ではない。
export interface SessionRow {
  id: string;
  guild_id: string;
  channel_id: string;
  channel_name: string | null;
  started_by: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: string | null;
  language: string | null;
  engine: string | null;
  transcript_key: string | null;
  transcript_json_key: string | null;
  created_at: number | null;
}
export type SessionSummary = Pick<SessionRow, 'id' | 'guild_id' | 'channel_id' | 'channel_name' | 'started_at' | 'ended_at' | 'status' | 'language' | 'engine'>;
export interface GuildSummary { guild_id: string; session_count: number; last_at: number | null }
export interface ChannelSummary { channel_id: string; channel_name: string | null; session_count: number; last_at: number | null }
export interface ParticipantRow { user_id: string; display_name: string | null; joined_at: number | null; left_at: number | null }
export interface TrackRow { id: string; user_id: string; r2_key: string | null; duration_sec: number | null }
export type SessionInsert = Pick<SessionRow, 'id' | 'guild_id' | 'channel_id'> & Partial<Omit<SessionRow, 'id' | 'guild_id' | 'channel_id' | 'created_at'>>;
export type ParticipantInsert = Pick<ParticipantRow, 'user_id'> & Partial<Omit<ParticipantRow, 'user_id'>>;
export type TrackInsert = Pick<TrackRow, 'user_id'> & Partial<Omit<TrackRow, 'id' | 'user_id'>>;

export interface SessionPayload { userId: string; username: string; accessToken: string; exp?: number }
export interface AccessResult { allowed: boolean; reason?: string }
export type AuthEnv = Pick<Env, 'SESSION_SECRET' | 'WEB_BASE_URL' | 'DISCORD_CLIENT_ID' | 'DISCORD_CLIENT_SECRET'>;

export interface IngestMeta {
  sessionId: string;
  guildId: string;
  channelId: string;
  channelName?: string | null;
  startedBy?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  language?: string | null;
  engine?: string | null;
  speakers?: { userId: string; durationSec?: number | null }[];
  participants?: { userId: string; displayName?: string | null; joinedAt?: number | null; leftAt?: number | null }[];
}
export interface AudioRequest {
  sessionId: string;
  userId: string;
  uploadId?: string;
  parts?: { partNumber: number; etag: string }[];
  durationSec?: number | null;
}
