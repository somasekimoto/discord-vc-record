/**
 * ingest.js — recorder からの取り込みエンドポイント
 *
 * recorder(Fly.io) が録音終了後にここへ POST し、
 * 音声/文字起こしを R2 に、メタデータを D1 に保存する。
 * 共有シークレット(INGEST_SECRET)の Bearer で認証する。
 *
 * リクエスト: multipart/form-data
 *   - meta:      JSON(セッション/参加者/トラック情報。transcript.json 相当)
 *   - transcript_md:  file (任意)
 *   - transcript_json: file (任意)
 *   - audio_<userId>: file (任意, wav)
 */
import { upsertSession, insertParticipants, insertTracks } from './db.js';

function unauthorized() {
  return new Response('unauthorized', { status: 401 });
}

export async function handleIngest(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.INGEST_SECRET || auth !== `Bearer ${env.INGEST_SECRET}`) return unauthorized();

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
