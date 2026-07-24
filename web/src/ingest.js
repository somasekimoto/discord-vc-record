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
 *
 * 音声は Cloudflare のリクエストボディ上限(100MB)に収まらないことがあるため、
 * /ingest には添付せず R2 マルチパートで分割アップロードする。
 * userId は話者の snowflake のほか、会話全体のミックス音声を表す "mixed" を受け付ける
 * (キーは audio/mixed.m4a、tracks には user_id="mixed" の行として載る):
 *   POST /ingest/audio/init      {sessionId, userId} → {key, uploadId}
 *   PUT  /ingest/audio/part?sessionId&userId&uploadId&partNumber  body=チャンク → {partNumber, etag}
 *   POST /ingest/audio/complete  {sessionId, userId, uploadId, parts, durationSec} → tracks.r2_key 更新
 *   POST /ingest/audio/abort     {sessionId, userId, uploadId}
 * いずれも /ingest で meta を登録済みのセッションにのみ受け付ける。
 *
 * complete は冪等: 完了済み uploadId で再送されても、オブジェクトが存在すれば 200 を返す
 * (recorder はレスポンス喪失時に complete をリトライするため)。
 * recorder がクラッシュして abort されなかったマルチパートは、R2 バケット既定の
 * ライフサイクル(incomplete multipart を7日で自動破棄)に掃除を任せる。
 */
import { upsertSession, insertParticipants, insertTracks } from './db.js';

function unauthorized() {
  return new Response('unauthorized', { status: 401 });
}

function checkIngestAuth(req, env) {
  const auth = req.headers.get('Authorization') || '';
  return Boolean(env.INGEST_SECRET) && auth === `Bearer ${env.INGEST_SECRET}`;
}

// R2 の仕様上パート番号は 1..10000
const MAX_PART_NUMBER = 10000;

// guildId/userId は R2 キーに補間されるため Discord snowflake(数字のみ)に限定し、
// sessionId も `/` 等でキー階層を壊せない文字種に限定する
const isSnowflake = (s) => typeof s === 'string' && /^\d{1,32}$/.test(s);
const isValidSessionId = (s) => typeof s === 'string' && /^[\w.-]{1,128}$/.test(s);
// 音声の userId: 話者の snowflake か、全体ミックスを表す固定値 "mixed"
const isValidAudioUserId = (s) => isSnowflake(s) || s === 'mixed';

/**
 * R2 の例外がクライアント起因(リトライで直らない)かの粗い分類。
 * R2 は HTTP ステータスを露出しないためメッセージで判定する。
 * 判定できないものは 500 のままにして recorder 側のリトライに委ねる。
 */
const isR2ClientError = (err) =>
  /does not exist|no such upload|not found|invalid|malformed|etag|already|too (small|large|many)/i
    .test(err?.message || '');

/** req.json() の失敗を 500 でなく 400 にするため null に落とす。 */
async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** sessionId から R2 の音声キーを組み立てる。セッション未登録なら null。 */
async function audioKeyFor(env, sessionId, userId) {
  const row = await env.DB.prepare('SELECT guild_id FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!row) return null;
  const filename = userId === 'mixed' ? 'mixed.m4a' : `${userId}.wav`;
  return `sessions/${row.guild_id}/${sessionId}/audio/${filename}`;
}

/** 共通の入力検証 + キー導出。失敗時は Response、成功時は { key } を返す。 */
async function resolveAudioKey(env, sessionId, userId) {
  if (!isValidSessionId(sessionId) || !isValidAudioUserId(userId)) {
    return new Response('invalid sessionId/userId', { status: 400 });
  }
  const key = await audioKeyFor(env, sessionId, userId);
  if (!key) return new Response('unknown session (POST /ingest first)', { status: 404 });
  return { key };
}

export async function handleAudioInit(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const body = await readJson(req);
  if (!body) return new Response('invalid json', { status: 400 });
  const { sessionId, userId } = body;
  const r = await resolveAudioKey(env, sessionId, userId);
  if (r instanceof Response) return r;
  const upload = await env.BUCKET.createMultipartUpload(r.key, {
    httpMetadata: { contentType: userId === 'mixed' ? 'audio/mp4' : 'audio/wav' },
  });
  return Response.json({ key: r.key, uploadId: upload.uploadId });
}

export async function handleAudioPart(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');
  const userId = url.searchParams.get('userId');
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = Number(url.searchParams.get('partNumber'));
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
    return new Response('missing/invalid params', { status: 400 });
  }
  if (!req.body) return new Response('missing body', { status: 400 });
  const r = await resolveAudioKey(env, sessionId, userId);
  if (r instanceof Response) return r;
  const upload = env.BUCKET.resumeMultipartUpload(r.key, uploadId);
  try {
    const part = await upload.uploadPart(partNumber, req.body);
    return Response.json({ partNumber: part.partNumber, etag: part.etag });
  } catch (err) {
    // 不正/失効した uploadId 等のクライアント起因のみ 400。
    // R2 の一時的な内部エラーは 500 のまま返し recorder のリトライに委ねる
    if (isR2ClientError(err)) return new Response(`upload part failed: ${err.message}`, { status: 400 });
    throw err;
  }
}

export async function handleAudioComplete(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const body = await readJson(req);
  if (!body) return new Response('invalid json', { status: 400 });
  const { sessionId, userId, uploadId, parts, durationSec } = body;
  if (!uploadId || !Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PART_NUMBER) {
    return new Response('missing fields', { status: 400 });
  }
  if (!parts.every((p) => Number.isInteger(p?.partNumber) && p.partNumber >= 1
      && p.partNumber <= MAX_PART_NUMBER && typeof p?.etag === 'string')) {
    return new Response('invalid parts', { status: 400 });
  }
  const r = await resolveAudioKey(env, sessionId, userId);
  if (r instanceof Response) return r;
  const upload = env.BUCKET.resumeMultipartUpload(r.key, uploadId);
  let alreadyCompleted = false;
  try {
    await upload.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
  } catch (err) {
    // complete 成功後にレスポンスが失われて recorder がリトライしてくるケースを冪等に救う。
    // キーは (sessionId, userId) 毎に決定的で uploadId を持たないため、この判定は
    // 「このuploadIdが完了した」ではなく「キーにオブジェクトが存在する」の近似。
    // 過去アップロード済みのトラックを reupload 中に新しい complete が本当に失敗した
    // 場合も 200 になりうるが、同一話者wavの同一キーなので実害は取り置きの旧データに留まる。
    if (!(await env.BUCKET.head(r.key))) {
      if (isR2ClientError(err)) return new Response(`complete failed: ${err.message}`, { status: 400 });
      throw err;
    }
    alreadyCompleted = true;
  }
  await insertTracks(env.DB, sessionId, [
    { user_id: userId, r2_key: r.key, duration_sec: durationSec ?? null },
  ]);
  return Response.json({ ok: true, key: r.key, alreadyCompleted });
}

export async function handleAudioAbort(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();
  const body = await readJson(req);
  if (!body) return new Response('invalid json', { status: 400 });
  const { sessionId, userId, uploadId } = body;
  if (!uploadId) return new Response('missing fields', { status: 400 });
  const r = await resolveAudioKey(env, sessionId, userId);
  if (r instanceof Response) return r;
  try {
    await env.BUCKET.resumeMultipartUpload(r.key, uploadId).abort();
  } catch {
    // 既に complete/abort 済みなど。abort は冪等に扱う
  }
  return Response.json({ ok: true });
}

export async function handleIngest(req, env) {
  if (!checkIngestAuth(req, env)) return unauthorized();

  const form = await req.formData();
  const metaRaw = form.get('meta');
  if (!metaRaw) return new Response('missing meta', { status: 400 });
  let meta;
  try {
    meta = JSON.parse(typeof metaRaw === 'string' ? metaRaw : await metaRaw.text());
  } catch {
    return new Response('invalid meta json', { status: 400 });
  }

  // audio エンドポイントと同じ検証。sessionId/guildId はここが R2 キー階層の起点になる
  const sessionId = meta.sessionId;
  if (!isValidSessionId(sessionId) || !isSnowflake(meta.guildId)) {
    return new Response('invalid sessionId/guildId', { status: 400 });
  }

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

  // トラック行を先に作る(r2_key は音声の complete 時に埋まる)。
  // 旧仕様の audio_<userId> 添付は受け付けない(100MB超で必ず 413 になるため廃止)。
  const trackRows = (meta.speakers || []).map((speaker) => ({
    user_id: speaker.userId, r2_key: null, duration_sec: speaker.durationSec,
  }));

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
