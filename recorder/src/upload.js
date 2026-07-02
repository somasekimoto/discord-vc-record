/**
 * upload.js — 文字起こし結果を web(Cloudflare Worker)の /ingest へ送る
 *
 * INGEST_SECRET の Bearer で認証。WEB_BASE_URL が未設定ならスキップ(ローカル保存のみ)。
 *
 * 音声を meta と同じ multipart に載せると、長尺録音では Cloudflare の
 * リクエストボディ上限(100MB)を超えて 413 になる(2時間3話者で計800MB超の実績あり)。
 * そのため 2 段階に分ける:
 *   1. meta + transcript(md/json) を POST /ingest(小さいので1リクエスト)
 *   2. wav をファイルごとに R2 マルチパート(init → 40MiB チャンク × part → complete)
 */
import { openAsBlob } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

// Cloudflare のボディ上限(100MB)に余裕をもって収め、R2 の最小パート(5MiB)以上にする
const PART_SIZE = 40 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[upload] ${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      // 4xx は再送しても結果が変わらない(408/429 は一時的なので除く)
      if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) break;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function expectOk(res, label) {
  if (!res.ok) {
    const err = new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** offset から length バイトを必ず読み切る。fh.read は1回で埋まる保証がない。 */
async function readExact(fh, length, offset) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
    if (bytesRead === 0) throw new Error(`unexpected EOF at ${offset + done} (want ${length} bytes)`);
    done += bytesRead;
  }
  return buf;
}

/** meta + 文字起こし(md/json)だけを /ingest に送る。音声は別途。 */
async function postMeta(base, secret, minutes, files) {
  const form = new FormData();
  form.set('meta', JSON.stringify({ ...minutes, startedBy: minutes.startedBy ?? null }));
  form.set('transcript_md', await openAsBlob(files.mdPath, { type: 'text/markdown' }), 'transcript.md');
  form.set('transcript_json', await openAsBlob(files.jsonPath, { type: 'application/json' }), 'transcript.json');
  await withRetry('ingest meta', async () => {
    const res = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
    });
    await expectOk(res, 'ingest');
  });
}

/** wav 1 本を R2 マルチパートで分割アップロードする。 */
async function uploadWav(base, secret, sessionId, wavPath, durationSec) {
  const userId = basename(wavPath).replace(/\.wav$/, '');
  const { size } = await stat(wavPath);
  const auth = { Authorization: `Bearer ${secret}` };
  const q = (extra) => new URLSearchParams({ sessionId, userId, ...extra }).toString();

  const { uploadId } = await withRetry(`audio init ${userId}`, async () => {
    const res = await fetch(`${base}/ingest/audio/init`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId }),
    });
    return (await expectOk(res, 'audio init')).json();
  });

  const fh = await open(wavPath, 'r');
  try {
    const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
    const parts = [];
    for (let i = 0; i < totalParts; i++) {
      const partNumber = i + 1;
      const length = Math.min(PART_SIZE, size - i * PART_SIZE);
      const buf = await readExact(fh, length, i * PART_SIZE);
      const part = await withRetry(`audio part ${userId} ${partNumber}/${totalParts}`, async () => {
        const res = await fetch(`${base}/ingest/audio/part?${q({ uploadId, partNumber })}`, {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        return (await expectOk(res, 'audio part')).json();
      });
      parts.push({ partNumber: part.partNumber, etag: part.etag });
      console.log(`[upload] ${userId}.wav part ${partNumber}/${totalParts} ok`);
    }

    await withRetry(`audio complete ${userId}`, async () => {
      const res = await fetch(`${base}/ingest/audio/complete`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userId, uploadId, parts, durationSec: durationSec ?? null }),
      });
      await expectOk(res, 'audio complete');
    });
  } catch (err) {
    // 失敗したマルチパートは放置せず破棄する(ベストエフォート)
    await fetch(`${base}/ingest/audio/abort`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, uploadId }),
    }).catch(() => {});
    throw err;
  } finally {
    await fh.close();
  }
}

/**
 * @param {object} minutes  pipeline が生成した構造化JSON(transcript.json 相当)
 * @param {{mdPath:string, jsonPath:string, wavPaths:string[]}} files
 * @returns {Promise<{uploaded:boolean, sessionId:string, viewUrl?:string, reason?:string}>}
 */
export async function uploadToWeb(minutes, files) {
  const base = process.env.WEB_BASE_URL;
  const secret = process.env.INGEST_SECRET;
  const sessionId = minutes.sessionId;
  if (!base || !secret) {
    return { uploaded: false, sessionId, reason: 'WEB_BASE_URL/INGEST_SECRET 未設定' };
  }

  // 1. meta + 文字起こし。ここが通ればセッションは WebUI に出る。
  try {
    await postMeta(base, secret, minutes, files);
  } catch (err) {
    return { uploaded: false, sessionId, reason: `ingest meta 失敗: ${err.message}` };
  }
  const viewUrl = `${base}/s/${sessionId}`;

  // 2. 話者別 wav。1 本失敗しても他は続行し、失敗分だけ reason に載せる。
  //    逐次実行でメモリ(チャンク40MiB×1)と帯域を抑える。
  const errors = [];
  for (const wavPath of files.wavPaths) {
    const userId = basename(wavPath).replace(/\.wav$/, '');
    const durationSec = (minutes.speakers || []).find((s) => s.userId === userId)?.durationSec;
    try {
      await uploadWav(base, secret, sessionId, wavPath, durationSec);
    } catch (err) {
      errors.push(`${userId}: ${err.message}`);
    }
  }

  if (errors.length) {
    return {
      uploaded: false, sessionId, viewUrl,
      reason: `文字起こしはアップロード済み。音声で失敗: ${errors.join(' / ')}`,
    };
  }
  return { uploaded: true, sessionId, viewUrl };
}
