/**
 * stt/openai.js — OpenAI 文字起こし実装（既定プロバイダ）
 *
 * モデル: gpt-4o-transcribe（日本語精度が高い）。
 * 制約: response_format は json/text のみ（verbose_json=セグメント非対応）、
 *       1ファイル 25MB / 1500秒 まで。超える場合は ffmpeg で時間分割して連結する。
 *
 * セグメント単位の細かいタイムスタンプは返らないため、segments は
 * 「ファイル全体を1セグメント」として返す。話者別トラックを前提に、
 * pipeline 側で話者ごとのセクションを組む設計。将来 whisper-1 や
 * 録音側タイムスタンプでインターリーブする場合はここを差し替える。
 */
import { createReadStream } from 'node:fs';
import { stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import OpenAI from 'openai';

const MODEL = process.env.OPENAI_STT_MODEL ?? 'gpt-4o-transcribe';
const MAX_BYTES = 24 * 1024 * 1024; // 25MB 制限に対し安全側
const CHUNK_SECONDS = 1200; // 1500秒制限に対し安全側（20分）

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY が設定されていません');
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err}`))));
    p.on('error', reject);
  });
}

async function transcribeOne(filePath, language) {
  const res = await client().audio.transcriptions.create({
    file: createReadStream(filePath),
    model: MODEL,
    language,
    response_format: 'json',
  });
  return res.text ?? '';
}

/**
 * @param {string} audioPath  wav/mp3 等
 * @param {{language?: string}} opts
 */
export async function transcribe(audioPath, { language = 'ja' } = {}) {
  const { size } = await stat(audioPath);

  // 制限内ならそのまま送る
  if (size <= MAX_BYTES) {
    const text = await transcribeOne(audioPath, language);
    return { text, segments: [{ start: 0, end: null, text }], engine: MODEL };
  }

  // 大きい場合は時間でチャンク分割（mp3 16kbps mono に落として更にサイズ削減）
  const dir = await mkdtemp(join(tmpdir(), 'stt-'));
  try {
    await ffmpeg([
      '-i', audioPath,
      '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
      '-reset_timestamps', '1',
      join(dir, 'chunk-%03d.mp3'),
    ]);

    const { readdir } = await import('node:fs/promises');
    const chunks = (await readdir(dir)).filter((f) => f.endsWith('.mp3')).sort();
    const parts = [];
    for (const c of chunks) {
      parts.push(await transcribeOne(join(dir, c), language));
    }
    const text = parts.join(' ');
    return { text, segments: [{ start: 0, end: null, text }], engine: MODEL };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
