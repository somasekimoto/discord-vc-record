/**
 * cleanup.js — 録音データのディスク掃除。
 *
 * 録音データは放置すると増え続け、Fly ボリュームを満杯にして録音自体を
 * 開始できなくする(ENOSPC)。しかも ENOSPC は stop 後の pipeline 途中でも
 * 起きるため、会議を録り切った後に文字起こしを失う。それを防ぐ。
 *
 * 2段構えで消す:
 *   1. deletePcmFiles()      — アップロード成功直後に中間物の PCM を消す(効果最大)
 *   2. purgeOldSessions()    — 保持期間を過ぎたセッションを丸ごと消す
 *
 * 正本は R2(web)側。ローカルはアップロード失敗時に reupload.js で復旧する
 * ための控えなので、保持期間を過ぎたら消してよい。
 *
 * どの掃除も失敗は握りつぶしてログに残すだけにする。掃除の失敗で録音や
 * 文字起こしを巻き込むと本末転倒なため。
 */
import { errorMessage, errorCode } from './types.ts';
import { readdir, stat, unlink, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';

/** 保持期間の既定(日)。reupload.js での復旧可能期間とのトレードオフ。 */
export const DEFAULT_RETENTION_DAYS = 14;

/**
 * 空き容量がこれを下回ったら警告する(バイト)。
 * 1セッションの実績が 800M〜1.2G なので、1本録り切れない水準を目安にする。
 */
export const LOW_SPACE_THRESHOLD_BYTES = 1.5 * 1024 ** 3;

/**
 * 空き容量を調べ、逼迫しているなら警告文を返す。
 *
 * 録音開始はブロックしない。会議を録れない方が損失が大きく、
 * 空きが少なくても録り切れる場合があるため、判断はユーザーに委ねる。
 *
 * @param {string} dir 調べる対象(録音ルート)
 * @param {number} [threshold]
 * @returns {Promise<{ok:boolean, freeBytes:number|null, warning:string|null}>}
 */
export async function checkDiskSpace(dir: string, threshold = LOW_SPACE_THRESHOLD_BYTES) {
  let freeBytes;
  try {
    const st = await statfs(dir);
    freeBytes = st.bavail * st.bsize;
  } catch (err) {
    // 容量が読めないだけで録音を止める理由にはならない
    console.error(`[cleanup] statfs failed for ${dir}: ${errorMessage(err)}`);
    return { ok: true, freeBytes: null, warning: null };
  }
  if (freeBytes >= threshold) return { ok: true, freeBytes, warning: null };
  return {
    ok: false,
    freeBytes,
    warning:
      `⚠ ディスクの空きが少なくなっています（残り ${formatBytes(freeBytes)}）。` +
      `長時間の録音は途中で失敗する可能性があります。`,
  };
}

/**
 * RECORDINGS_RETENTION_DAYS(日) をミリ秒にパースする。
 * 未設定・不正値は既定、0 は自動削除の無効を意味する。
 */
export function parseRetentionMs(raw: string | null | undefined) {
  if (raw == null || raw === '') return DEFAULT_RETENTION_DAYS * 86400_000;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS * 86400_000;
  return days * 86400_000;
}

/**
 * セッションディレクトリ内の .pcm を削除する。
 *
 * PCM は wav 生成の中間物で、アップロード後に参照する箇所は無い
 * (reupload.js が使うのは transcript.json / <userId>.wav / mixed.m4a のみ)。
 * よってアップロード成功後に消しても復旧手段を壊さない。
 *
 * @param {string} dir セッションディレクトリ
 * @returns {Promise<{deleted:number, freedBytes:number}>}
 */
export async function deletePcmFiles(dir: string) {
  let deleted = 0;
  let freedBytes = 0;
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    console.error(`[cleanup] failed to read ${dir}: ${errorMessage(err)}`);
    return { deleted, freedBytes };
  }

  for (const name of entries) {
    if (!name.endsWith('.pcm')) continue;
    const full = join(dir, name);
    try {
      // サイズは削除前にしか取れない(解放量のログ用)
      const size = await stat(full).then((s) => s.size).catch(() => 0);
      await unlink(full);
      deleted += 1;
      freedBytes += size;
    } catch (err) {
      console.error(`[cleanup] failed to delete ${full}: ${errorMessage(err)}`);
    }
  }
  if (deleted > 0) {
    console.log(`[cleanup] removed ${deleted} pcm file(s), freed ${formatBytes(freedBytes)} in ${dir}`);
  }
  return { deleted, freedBytes };
}

/**
 * 保持期間を過ぎたセッションディレクトリを削除する。
 *
 * 判定は mtime。アップロード済みかはローカルでは分からない(recorder は
 * 完了マーカーを持たない)ため、「保持期間を過ぎたものは復旧を諦める」
 * という割り切りで消す。期間内であれば reupload.js で復旧できる。
 *
 * @param {string} baseDir 録音ルート
 * @param {object} [opts]
 * @param {number} [opts.retentionMs] 保持期間(0 で無効)
 * @param {() => number} [opts.now] テスト用の時刻取得
 * @param {Set<string>|string[]} [opts.keep] 進行中などで消してはいけないセッションID
 * @returns {Promise<{deleted:string[], freedBytes:number}>}
 */
export async function purgeOldSessions(baseDir: string, { retentionMs, now = Date.now, keep = [] }: { retentionMs?: number; now?: () => number; keep?: Set<string> | string[] } = {}) {
  const deleted: string[] = [];
  let freedBytes = 0;
  if (!retentionMs) return { deleted, freedBytes }; // 0 は無効

  const keepSet = new Set(keep);
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    // 初回起動でディレクトリが無い場合を含む。掃除できなくても起動は続ける。
    if (errorCode(err) !== 'ENOENT') console.error(`[cleanup] failed to read ${baseDir}: ${errorMessage(err)}`);
    return { deleted, freedBytes };
  }

  const threshold = now() - retentionMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (keepSet.has(entry.name)) continue; // 録音中のセッションは触らない

    const full = join(baseDir, entry.name);
    try {
      const { mtimeMs } = await stat(full);
      if (mtimeMs >= threshold) continue;
      const size = await dirSize(full);
      await rm(full, { recursive: true, force: true });
      deleted.push(entry.name);
      freedBytes += size;
    } catch (err) {
      console.error(`[cleanup] failed to purge ${full}: ${errorMessage(err)}`);
    }
  }
  if (deleted.length > 0) {
    console.log(
      `[cleanup] purged ${deleted.length} session(s) older than ` +
        `${Math.round(retentionMs / 86400_000)}d, freed ${formatBytes(freedBytes)}`,
    );
  }
  return { deleted, freedBytes };
}

/** ディレクトリ配下の合計バイト数(解放量のログ用。失敗しても 0 で続行)。 */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else {
      total += await stat(full).then((s) => s.size).catch(() => 0);
    }
  }
  return total;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)}${units[i]}`;
}
