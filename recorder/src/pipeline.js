/**
 * pipeline.js — 録音終了後のまとめ処理
 *
 * 流れ:
 *   1. 各話者の PCM を ffmpeg で wav 化（STT に渡せる形式）
 *   2. recorder が記録した発話区間(実時刻+PCM内バイト位置)ごとに wav を切り出し、
 *      区間単位で文字起こしする。話者トラックから切り出すので誤帰属が起きない。
 *   3. 発話区間を実時刻に沿って1本に重ねた「会話全体のミックス音声」(mixed.m4a)を生成
 *   4. 全話者の発話を開始時刻順にマージして時系列の議事録(Markdown)と
 *      構造化 JSON(utterances + 後方互換の speakers)に組む
 *   5. ローカルに保存し、web(R2/D1)へアップロード
 *
 * PCM には発話部分だけが連結されて無音が潰れているため、STT のタイムスタンプでは
 * 実時刻を復元できない。時系列の根拠は recorder の utterances のみ。
 *
 * 出力はセッションディレクトリ直下:
 *   transcript.md / transcript.json / <userId>.wav / mixed.m4a
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PCM_FORMAT } from './recorder.js';
import { ffmpeg } from './ffmpeg.js';
import { buildMixedAudio } from './mix.js';
import { transcribe, getProviderName } from './stt/index.js';
import { uploadToWeb } from './upload.js';

const BYTES_PER_SEC = PCM_FORMAT.sampleRate * PCM_FORMAT.channels * (PCM_FORMAT.bitsPerSample / 8);
// 同一話者の発話間ギャップがこれ以下なら 1 区間に結合(STT 呼び出し数と文脈切れを抑える)
const MERGE_GAP_MS = 1500;
// これより短い区間はスキップ(短すぎる音声は STT が不安定で幻覚も出やすい)
const MIN_SEGMENT_MS = 300;
// 切り出し時のパディング。byteEnd は decoder 未 flush 分(数十ms)だけ手前になりうるため、
// 隣接区間に食い込まない範囲で後ろへ延ばして語尾の欠けを防ぐ
const PAD_SEC = 0.25;
// STT の並列数。区間単位の呼び出しは数が多いので並列化しつつ、レート制限に配慮する
const STT_CONCURRENCY = 4;

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

/** wav から [startSec, startSec+durSec) を切り出す。 */
async function cutSegment(srcWav, outPath, startSec, durSec) {
  await ffmpeg(['-ss', startSec.toFixed(3), '-t', durSec.toFixed(3), '-i', srcWav, outPath]);
}

function fmtClock(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** セッション開始からの経過時間を m:ss / h:mm:ss で整形する。 */
export function fmtOffset(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * 近接する発話区間を結合し、短すぎる区間を除く。
 * 入力は同一話者の時刻昇順(= PCM 内バイト位置も昇順)であることが前提。
 */
export function mergeUtterances(utterances) {
  const merged = [];
  for (const u of utterances) {
    const last = merged[merged.length - 1];
    if (last && u.startedAt - last.endedAt <= MERGE_GAP_MS) {
      last.endedAt = u.endedAt;
      last.byteEnd = u.byteEnd;
    } else {
      merged.push({ ...u });
    }
  }
  return merged.filter((u) => ((u.byteEnd - u.byteStart) / BYTES_PER_SEC) * 1000 >= MIN_SEGMENT_MS);
}

/** jobs(async 関数の配列)を並列度 limit で全て実行する。 */
async function runWithConcurrency(jobs, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      await jobs[next++]();
    }
  });
  await Promise.all(workers);
}

/**
 * 録音セッションを文字起こしして時系列の議事録を生成する。
 *
 * @param {object} summary  RecordingSession._summary() の戻り
 * @param {Array<{userId,displayName,pcmPath,bytes,durationSec,utterances}>} tracks
 * @returns {Promise<{ markdown: string, minutes: object, files: {wavPaths: string[], mdPath: string, jsonPath: string} }>}
 */
export async function process(summary, tracks) {
  const dir = summary.dir;
  const engine = getProviderName();
  const wavPaths = [];

  // 1. 話者ごとに wav 化。1 話者の失敗はその話者だけスキップして他を救う。
  const speakerTracks = [];
  for (const t of tracks) {
    const wavPath = join(dir, `${t.userId}.wav`);
    try {
      await pcmToWav(t.pcmPath, wavPath);
      wavPaths.push(wavPath);
      speakerTracks.push({ ...t, wavPath });
    } catch (err) {
      console.error(`[pipeline] wav conversion failed user=${t.userId}: ${err.message}`);
      speakerTracks.push({ ...t, wavPath: null, error: err.message });
    }
  }

  // 2. 発話区間ごとに切り出して STT。全話者分のジョブをまとめて並列実行する。
  /** @type {Array<{userId,displayName,startedAt,endedAt,text}>} */
  const utterances = [];
  // 発話区間が記録されていないトラック(旧録音・異常系)の旧方式(トラック全体一括)結果
  const noTimelineSpeakers = [];
  const segDir = await mkdtemp(join(tmpdir(), 'stt-seg-'));
  try {
    const jobs = [];
    for (const t of speakerTracks) {
      if (!t.wavPath) continue;
      const merged = mergeUtterances(t.utterances ?? []);

      if (merged.length === 0) {
        jobs.push(async () => {
          let text;
          try {
            text = (await transcribe(t.wavPath, { language: 'ja' })).text.trim();
          } catch (err) {
            console.error(`[pipeline] speaker failed user=${t.userId}: ${err.message}`);
            text = `（文字起こし失敗: ${err.message}）`;
          }
          noTimelineSpeakers.push({ userId: t.userId, displayName: t.displayName, text });
        });
        continue;
      }

      const trackEndSec = t.bytes / BYTES_PER_SEC;
      merged.forEach((u, i) => {
        jobs.push(async () => {
          // 無音が潰れた PCM では隣接区間がほぼ連続しているため、
          // パディングは隣の区間に食い込まない範囲にクランプする
          const prevEndSec = i > 0 ? merged[i - 1].byteEnd / BYTES_PER_SEC : 0;
          const nextStartSec = i < merged.length - 1 ? merged[i + 1].byteStart / BYTES_PER_SEC : trackEndSec;
          const startSec = Math.max(prevEndSec, u.byteStart / BYTES_PER_SEC - PAD_SEC);
          const endSec = Math.min(nextStartSec, u.byteEnd / BYTES_PER_SEC + PAD_SEC);
          if (endSec - startSec <= 0) return;

          const segPath = join(segDir, `${t.userId}-${String(i).padStart(4, '0')}.wav`);
          let text;
          try {
            await cutSegment(t.wavPath, segPath, startSec, endSec - startSec);
            text = (await transcribe(segPath, { language: 'ja' })).text.trim();
          } catch (err) {
            console.error(`[pipeline] segment failed user=${t.userId} #${i}: ${err.message}`);
            text = `（文字起こし失敗: ${err.message}）`;
          } finally {
            await rm(segPath, { force: true }).catch(() => {});
          }
          if (!text) return; // 無音・ノイズで空文字なら議事録に載せない
          utterances.push({
            userId: t.userId,
            displayName: t.displayName,
            startedAt: u.startedAt,
            endedAt: u.endedAt,
            text,
          });
        });
      });
    }
    await runWithConcurrency(jobs, STT_CONCURRENCY);
  } finally {
    await rm(segDir, { recursive: true, force: true }).catch(() => {});
  }
  utterances.sort((a, b) => a.startedAt - b.startedAt);

  // 3. 会話全体のミックス音声。失敗しても文字起こしの成果は損なわない(音声なしで続行)。
  let mixed = null;
  try {
    mixed = await buildMixedAudio(summary, tracks, join(dir, 'mixed.m4a'));
  } catch (err) {
    console.error(`[pipeline] mixed audio failed: ${err.message}`);
  }

  // 4. 構造化 JSON。utterances が時系列の本体。
  // speakers は web(ingest/upload) が durationSec 等を参照するため後方互換で残す。
  const perSpeaker = speakerTracks.map((t) => {
    let text;
    if (!t.wavPath) {
      text = `（文字起こし失敗: ${t.error}）`;
    } else {
      const fallback = noTimelineSpeakers.find((s) => s.userId === t.userId);
      text = fallback
        ? fallback.text
        : utterances.filter((u) => u.userId === t.userId).map((u) => u.text).join('\n');
    }
    return {
      userId: t.userId,
      displayName: t.displayName,
      durationSec: t.durationSec,
      text,
      engine,
    };
  });

  const minutes = {
    sessionId: summary.id,
    guildId: summary.guildId,
    channelId: summary.channelId,
    channelName: summary.channelName ?? null,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    language: 'ja',
    engine,
    participants: summary.participants.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
    })),
    utterances,
    speakers: perSpeaker,
  };

  // 4. Markdown 議事録(時系列の会話ログ)
  const durationMin = summary.endedAt && summary.startedAt
    ? ((summary.endedAt - summary.startedAt) / 60000).toFixed(1)
    : '?';
  const lines = [];
  lines.push(`# 文字起こし — ${fmtClock(summary.startedAt)}〜${fmtClock(summary.endedAt)}`);
  lines.push('');
  lines.push(`- セッション: \`${summary.id}\``);
  lines.push(`- 長さ: 約 ${durationMin} 分`);
  lines.push(`- 参加者: ${summary.participants.map((p) => p.displayName).join('、')}`);
  lines.push(`- 文字起こしエンジン: ${engine}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 会話ログ');
  lines.push('');
  if (utterances.length === 0 && noTimelineSpeakers.length === 0) {
    lines.push('（発話なし）');
    lines.push('');
  }
  for (const u of utterances) {
    const at = fmtOffset(u.startedAt - summary.startedAt);
    lines.push(`**[${at}] ${u.displayName}**: ${u.text.replace(/\s*\n\s*/g, ' ')}`);
    lines.push('');
  }
  if (noTimelineSpeakers.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 話者別（時刻情報なし）');
    lines.push('');
    for (const s of noTimelineSpeakers) {
      lines.push(`### ${s.displayName}`);
      lines.push('');
      lines.push(s.text || '（発話なし）');
      lines.push('');
    }
  }
  const markdown = lines.join('\n');

  // 5. ローカル保存
  const mdPath = join(dir, 'transcript.md');
  const jsonPath = join(dir, 'transcript.json');
  await writeFile(mdPath, markdown, 'utf8');
  await writeFile(jsonPath, JSON.stringify(minutes, null, 2), 'utf8');

  // 5. web(R2/D1)へアップロード。未設定ならスキップ(ローカル保存のみ)。
  const files = { wavPaths, mdPath, jsonPath, mixedPath: mixed?.path ?? null };
  let upload = { uploaded: false };
  try {
    upload = await uploadToWeb(minutes, files);
  } catch (err) {
    upload = { uploaded: false, reason: err.message };
  }

  return { markdown, minutes, files, upload };
}
