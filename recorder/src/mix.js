/**
 * mix.js — 会話全体を1本で聴けるミックス音声の生成
 *
 * 話者別 PCM は発話部分だけが連結されて無音が潰れているため、そのまま重ねても
 * 会話にならない。recorder が記録した発話区間(実時刻+PCM内バイト位置)を使い、
 * セッション実時間軸のミックス PCM に各発話を合算配置してから m4a(AAC) に
 * エンコードする。無音は実時間どおり残る(AAC なら無音はよく縮む)。
 *
 * メモリに全体を載せない: ミックス PCM をセッション長で確保(truncate、疎ファイル)し、
 * 発話区間ごとに read-modify-write でチャンク合算する。話者の被り(同時発話)も
 * 同じ合算で自然に混ざる。
 */
import { open, rm } from 'node:fs/promises';
import { PCM_FORMAT } from './recorder.js';
import { ffmpeg } from './ffmpeg.js';

const BYTES_PER_SEC = PCM_FORMAT.sampleRate * PCM_FORMAT.channels * (PCM_FORMAT.bitsPerSample / 8);
// s16le stereo の1サンプルフレーム。全オフセットをこの境界に揃える
const FRAME_BYTES = PCM_FORMAT.channels * (PCM_FORMAT.bitsPerSample / 8);
// 合算時の read-modify-write チャンク
const CHUNK_BYTES = 1024 * 1024;
// 音声のみなので控えめなビットレートで十分
const AAC_BITRATE = '96k';

const alignDown = (n) => n - (n % FRAME_BYTES);
const msToBytes = (ms) => alignDown(Math.max(0, Math.round((ms / 1000) * BYTES_PER_SEC)));

/**
 * ミックスの配置計画を作る(純粋関数)。
 *
 * @param {{startedAt:number, endedAt:number}} summary
 * @param {Array<{pcmPath:string, bytes:number, utterances:Array}>} tracks
 * @returns {{totalBytes:number, tracks:Array<{srcPath:string, segments:Array<{srcStart:number, length:number, dstOffset:number}>}>}|null}
 *   配置できる発話が1つも無ければ null(旧録音など utterances 未記録のトラックは除外)
 */
export function computeMixPlan(summary, tracks) {
  let totalBytes = msToBytes((summary.endedAt ?? summary.startedAt) - summary.startedAt);
  const planTracks = [];

  for (const t of tracks) {
    const segments = [];
    for (const u of t.utterances ?? []) {
      // recorder はフレーム境界で数えるが、異常系(エラー後のサイズ再同期)に備えて揃える
      const srcStart = alignDown(Math.max(0, u.byteStart));
      const srcEnd = alignDown(Math.min(u.byteEnd, t.bytes));
      const length = srcEnd - srcStart;
      if (length <= 0) continue;
      const dstOffset = msToBytes(u.startedAt - summary.startedAt);
      segments.push({ srcStart, length, dstOffset });
      totalBytes = Math.max(totalBytes, dstOffset + length);
    }
    if (segments.length) planTracks.push({ srcPath: t.pcmPath, segments });
  }

  if (!planTracks.length || totalBytes <= 0) return null;
  return { totalBytes, tracks: planTracks };
}

/** offset から length バイトを buf に必ず読み切る(fh.read は1回で埋まる保証がない)。 */
async function readExact(fh, buf, length, offset) {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
    if (bytesRead === 0) throw new Error(`unexpected EOF at ${offset + done}`);
    done += bytesRead;
  }
}

/**
 * 計画に従ってミックス PCM(s16le 48k stereo)を書き出す。
 * 既存内容に int16 で合算(クリップ付き)するため、話者間の重なりもそのまま混ざる。
 */
export async function writeMixedPcm(plan, outPath) {
  const out = await open(outPath, 'w+');
  try {
    // セッション長ぶん先に確保する。未書き込み領域は 0(=無音)として読める
    await out.truncate(plan.totalBytes);
    const src = Buffer.alloc(CHUNK_BYTES);
    const dst = Buffer.alloc(CHUNK_BYTES);
    for (const track of plan.tracks) {
      const fh = await open(track.srcPath, 'r');
      try {
        for (const seg of track.segments) {
          for (let done = 0; done < seg.length; ) {
            const n = Math.min(CHUNK_BYTES, seg.length - done);
            await readExact(fh, src, n, seg.srcStart + done);
            await readExact(out, dst, n, seg.dstOffset + done);
            for (let i = 0; i + 1 < n; i += 2) {
              const v = src.readInt16LE(i) + dst.readInt16LE(i);
              dst.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
            }
            await out.write(dst, 0, n, seg.dstOffset + done);
            done += n;
          }
        }
      } finally {
        await fh.close();
      }
    }
  } finally {
    await out.close();
  }
}

/**
 * セッション全体のミックス音声(m4a)を生成する。
 *
 * @returns {Promise<{path:string, durationSec:number}|null>} 配置できる発話が無ければ null
 */
export async function buildMixedAudio(summary, tracks, outPath) {
  const plan = computeMixPlan(summary, tracks);
  if (!plan) return null;

  const pcmPath = `${outPath}.tmp.pcm`;
  try {
    await writeMixedPcm(plan, pcmPath);
    // AAC(native encoder) は ffmpeg のビルドに常に含まれるので依存を増やさない
    await ffmpeg([
      '-f', 's16le',
      '-ar', String(PCM_FORMAT.sampleRate),
      '-ac', String(PCM_FORMAT.channels),
      '-i', pcmPath,
      '-c:a', 'aac',
      '-b:a', AAC_BITRATE,
      outPath,
    ]);
  } finally {
    await rm(pcmPath, { force: true }).catch(() => {});
  }
  return { path: outPath, durationSec: Math.round(plan.totalBytes / BYTES_PER_SEC) };
}
