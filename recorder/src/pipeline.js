/**
 * pipeline.js — 録音終了後のまとめ処理
 *
 * 流れ:
 *   1. 各話者の PCM を ffmpeg で wav 化（STT に渡せる形式）
 *   2. STT 抽象化レイヤー(stt/index.js)で話者ごとに文字起こし
 *   3. 話者別の結果を 1 つの議事録(Markdown)と構造化 JSON に組む
 *   4. ローカルに保存（R2/D1 アップロードは Phase 3 で追加）
 *
 * 出力はセッションディレクトリ直下:
 *   transcript.md / transcript.json / <userId>.wav
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PCM_FORMAT } from './recorder.js';
import { transcribe, getProviderName } from './stt/index.js';
import { uploadToWeb } from './upload.js';

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err}`))));
    p.on('error', reject);
  });
}

/** 生 PCM(s16le 48k stereo) を wav に変換してパスを返す。 */
async function pcmToWav(pcmPath, wavPath) {
  await ffmpeg([
    '-f', 's16le',
    '-ar', String(PCM_FORMAT.sampleRate),
    '-ac', String(PCM_FORMAT.channels),
    '-i', pcmPath,
    wavPath,
  ]);
  return wavPath;
}

function fmtClock(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 録音セッションを文字起こしして議事録を生成する。
 *
 * @param {object} summary  RecordingSession._summary() の戻り
 * @param {Array<{userId,displayName,pcmPath,bytes,durationSec}>} tracks
 * @returns {Promise<{ markdown: string, minutes: object, files: {wavPaths: string[], mdPath: string, jsonPath: string} }>}
 */
export async function process(summary, tracks) {
  const dir = summary.dir;
  const wavPaths = [];

  // 1+2. 話者ごとに wav 化 → 文字起こし。
  // 長尺(1〜2時間)×複数話者は逐次で処理してピークメモリを抑える。
  // 1 話者の wav 化や STT が失敗しても、その話者だけスキップして他は救う
  // (以前は pcmToWav が try の外にあり、1 トラック失敗で議事録全体が生成されなかった)。
  const perSpeaker = [];
  for (const t of tracks) {
    const wavPath = join(dir, `${t.userId}.wav`);

    let text;
    let engine = getProviderName();
    try {
      await pcmToWav(t.pcmPath, wavPath);
      wavPaths.push(wavPath);
      const result = await transcribe(wavPath, { language: 'ja' });
      text = result.text.trim();
      engine = result.engine;
    } catch (err) {
      console.error(`[pipeline] speaker failed user=${t.userId}: ${err.message}`);
      text = `（文字起こし失敗: ${err.message}）`;
    }
    perSpeaker.push({
      userId: t.userId,
      displayName: t.displayName,
      durationSec: t.durationSec,
      text,
      engine,
    });
  }

  // 3. 構造化 JSON
  const minutes = {
    sessionId: summary.id,
    guildId: summary.guildId,
    channelId: summary.channelId,
    channelName: summary.channelName ?? null,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    language: 'ja',
    engine: getProviderName(),
    participants: summary.participants.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
    })),
    speakers: perSpeaker,
  };

  // 3. Markdown 議事録（話者ごとのセクション）
  const durationMin = summary.endedAt && summary.startedAt
    ? ((summary.endedAt - summary.startedAt) / 60000).toFixed(1)
    : '?';
  const lines = [];
  lines.push(`# 文字起こし — ${fmtClock(summary.startedAt)}〜${fmtClock(summary.endedAt)}`);
  lines.push('');
  lines.push(`- セッション: \`${summary.id}\``);
  lines.push(`- 長さ: 約 ${durationMin} 分`);
  lines.push(`- 参加者: ${summary.participants.map((p) => p.displayName).join('、')}`);
  lines.push(`- 文字起こしエンジン: ${getProviderName()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const s of perSpeaker) {
    lines.push(`## ${s.displayName}`);
    lines.push('');
    lines.push(s.text || '（発話なし）');
    lines.push('');
  }
  const markdown = lines.join('\n');

  // 4. ローカル保存
  const mdPath = join(dir, 'transcript.md');
  const jsonPath = join(dir, 'transcript.json');
  await writeFile(mdPath, markdown, 'utf8');
  await writeFile(jsonPath, JSON.stringify(minutes, null, 2), 'utf8');

  // 5. web(R2/D1)へアップロード。未設定ならスキップ(ローカル保存のみ)。
  const files = { wavPaths, mdPath, jsonPath };
  let upload = { uploaded: false };
  try {
    upload = await uploadToWeb(minutes, files);
  } catch (err) {
    upload = { uploaded: false, reason: err.message };
  }

  return { markdown, minutes, files, upload };
}
