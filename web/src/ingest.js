/**
 * ingest.js — recorder からの取り込みエンドポイント
 *
 * recorder(Fly.io) が録音終了後にここへ POST し、
 * 音声/文字起こしを R2 に、メタデータを D1 に保存する。
 * 共有シークレット(INGEST_SECRET)の Bearer で認証する。
 *
 * POST /ingest: multipart/form-data
 *   - meta:      JSON(セッション/参加者/トラック情報。transcript.json 相当)
 *   - transcript_md:  file (任意)
 *   - transcript_json: file (任意)
 *   - audio_<userId>: file (任意, wav)
 *
 * 音声は Cloudflare のリクエストボディ上限(100MB)に収まらないことがあるため、
 * /ingest には添付せず R2 マルチパートで分割アップロードする:
 *   POST /ingest/audio/init      {sessionId, userId} → {key, uploadId}
 *   PUT  /ingest/audio/part?sessionId&userId&uploadId&partNumber  body=チャンク → {partNumber, etag}
 *   POST /ingest/audio/complete  {sessionId, userId, uploadId, parts, durationSec} → tracks.r2_key 更新
 *   POST /ingest/audio/abort     {sessionId, userId, uploadId}
 * いずれも /ingest で meta を登録済みのセッションにのみ受け付ける。
 */
import { upsertSession, insertParticipants, insertTracks } from './db.js';

function unauthorized() {
  return new Response('unauthorized', { status: 401 });
}

function checkIngestAuth(req, env) {
  const auth = req.headers.get('Authorization') || '';
  return Boolean(env.INGEST_SECRET) && auth === `Bearer ${env.INGEST_SECRET}`;
}

/** sessionId から R2 の音声キーを組み立てる。セッション未登録なら null。 */
async function audioKeyFor(env, sessionId, userId) {
  const row = await env.DB.prepare('SELECT guild_id FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!row) return null;
  return `sessions/${row.guild_id}/${sessionId}/audio/${userId}.wav`;
}

export async function handleAudioInit(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const { sessionId, userId } = await req.json();
  if (!sessionId || !userId) return new Response('missing sessionId/userId', { status: 400 });
  const key = await audioKeyFor(env, sessionId, userId);
  if (!key) return new Response('unknown session (POST /ingest first)', { status: 404 });
  const upload = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: 'audio/wav' },
  });
  return Response.json({ key, uploadId: upload.uploadId });
}

export async function handleAudioPart(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');
  const userId = url.searchParams.get('userId');
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = Number(url.searchParams.get('partNumber'));
  if (!sessionId || !userId || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    return new Response('missing/invalid params', { status: 400 });
  }
  if (!req.body) return new Response('missing body', { status: 400 });
  const key = await audioKeyFor(env, sessionId, userId);
  if (!key) return new Response('unknown session', { status: 404 });
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, req.body);
  return Response.json({ partNumber: part.partNumber, etag: part.etag });
}

export async function handleAudioComplete(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const { sessionId, userId, uploadId, parts, durationSec } = await req.json();
  if (!sessionId || !userId || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return new Response('missing fields', { status: 400 });
  }
  const key = await audioKeyFor(env, sessionId, userId);
  if (!key) return new Response('unknown session', { status: 404 });
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  await upload.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
  await insertTracks(env.DB, sessionId, [
    { user_id: userId, r2_key: key, duration_sec: durationSec ?? null },
  ]);
  return Response.json({ ok: true, key });
}

export async function handleAudioAbort(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const { sessionId, userId, uploadId } = await req.json();
  if (!sessionId || !userId || !uploadId) return new Response('missing fields', { status: 400 });
  const key = await audioKeyFor(env, sessionId, userId);
  if (!key) return new Response('unknown session', { status: 404 });
  await env.BUCKET.resumeMultipartUpload(key, uploadId).abort();
  return Response.json({ ok: true });
}

export async function handleIngest(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();

  const form = await req.formData();
  const metaRaw = form.get('meta');
  if (!metaRaw) return new Response('missing meta', { status: 400 });
  const meta = JSON.parse(typeof metaRaw === 'string' ? metaRaw : await metaRaw.text());

  const sessionId = meta.sessionId;
  if (!sessionId) return new Response('missing sessionId', { status: 400 });

  const prefix = `sessions/${meta.guildId}/${sessionId}`;
  let transcriptKey = null;
  let transcriptJsonKey = null;

  // 文字起こしを R2 へ
  const md = form.get('transcript_md');
  if (md && typeof md !== 'string') {
    transcriptKey = `${prefix}/transcript.md`;
    await env.BUCKET.put(transcriptKey, md.stream(), {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    });
  }
  const tjson = form.get('transcript_json');
  if (tjson && typeof tjson !== 'string') {
    transcriptJsonKey = `${prefix}/transcript.json`;
    await env.BUCKET.put(transcriptJsonKey, tjson.stream(), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
  }

  // 音声(話者別 wav)を R2 へ
  const trackRows = [];
  for (const speaker of meta.speakers || []) {
    const file = form.get(`audio_${speaker.userId}`);
    let r2Key = null;
    if (file && typeof file !== 'string') {
      r2Key = `${prefix}/audio/${speaker.userId}.wav`;
      await env.BUCKET.put(r2Key, file.stream(), {
        httpMetadata: { contentType: 'audio/wav' },
      });
    }
    trackRows.push({ user_id: speaker.userId, r2_key: r2Key, duration_sec: speaker.durationSec });
  }

  // メタデータを D1 へ
  await upsertSession(env.DB, {
    id: sessionId,
    guild_id: meta.guildId,
    channel_id: meta.channelId,
    channel_name: meta.channelName ?? null,
    started_by: meta.startedBy ?? null,
    started_at: meta.startedAt,
    ended_at: meta.endedAt,
    status: 'done',
    language: meta.language ?? 'ja',
    engine: meta.engine ?? null,
    transcript_key: transcriptKey,
    transcript_json_key: transcriptJsonKey,
  });
  await insertParticipants(
    env.DB,
    sessionId,
    (meta.participants || []).map((p) => ({
      user_id: p.userId, display_name: p.displayName, joined_at: p.joinedAt, left_at: p.leftAt,
    })),
  );
  await insertTracks(env.DB, sessionId, trackRows);

  return Response.json({ ok: true, sessionId, transcriptKey });
}
