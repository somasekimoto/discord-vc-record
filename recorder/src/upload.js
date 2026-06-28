/**
 * upload.js — 文字起こし結果を web(Cloudflare Worker)の /ingest へ送る
 *
 * INGEST_SECRET の Bearer で認証。WEB_BASE_URL が未設定ならスキップ(ローカル保存のみ)。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * @param {object} minutes  pipeline が生成した構造化JSON(transcript.json 相当)
 * @param {{mdPath:string, jsonPath:string, wavPaths:string[]}} files
 * @returns {Promise<{uploaded:boolean, sessionId:string, viewUrl?:string, reason?:string}>}
 */
export async function uploadToWeb(minutes, files) {
  const base = process.env.WEB_BASE_URL;
  const secret = process.env.INGEST_SECRET;
  if (!base || !secret) {
    return { uploaded: false, sessionId: minutes.sessionId, reason: 'WEB_BASE_URL/INGEST_SECRET 未設定' };
  }

  const form = new FormData();
  form.set('meta', JSON.stringify({ ...minutes, startedBy: minutes.startedBy ?? null }));

  const md = await readFile(files.mdPath);
  form.set('transcript_md', new Blob([md], { type: 'text/markdown' }), 'transcript.md');
  const js = await readFile(files.jsonPath);
  form.set('transcript_json', new Blob([js], { type: 'application/json' }), 'transcript.json');

  // 話者別 wav。ファイル名 <userId>.wav から userId を取り出して audio_<userId> で送る。
  for (const wav of files.wavPaths) {
    const userId = basename(wav).replace(/\.wav$/, '');
    const buf = await readFile(wav);
    form.set(`audio_${userId}`, new Blob([buf], { type: 'audio/wav' }), `${userId}.wav`);
  }

  const res = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
    body: form,
  });
  if (!res.ok) {
    return { uploaded: false, sessionId: minutes.sessionId, reason: `ingest ${res.status}: ${await res.text()}` };
  }
  const viewUrl = `${base}/s/${minutes.sessionId}`;
  return { uploaded: true, sessionId: minutes.sessionId, viewUrl };
}
