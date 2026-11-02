/**
 * cleanup のユニットテスト:
 * PCM 削除・保持期間による一括削除・空き容量チェックを実ファイルで検証する。
 */
import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deletePcmFiles,
  purgeOldSessions,
  parseRetentionMs,
  checkDiskSpace,
  formatBytes,
  DEFAULT_RETENTION_DAYS,
} from '../src/cleanup.ts';

const DAY_MS = 86400_000;

async function makeBase() {
  return await mkdtemp(join(tmpdir(), 'cleanup-test-'));
}

/** セッションディレクトリを作る。ageDays 指定で mtime を過去にずらす。 */
async function makeSession(base: string, id: string, { files = ['u1.pcm', 'u1.wav'], ageDays = 0 } = {}) {
  const dir = join(base, id);
  await mkdir(dir, { recursive: true });
  for (const name of files) {
    await writeFile(join(dir, name), 'x'.repeat(16));
  }
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * DAY_MS);
    await utimes(dir, t, t);
  }
  return dir;
}

test('deletePcmFiles: pcm だけ消し、wav と transcript は残す', async () => {
  const base = await makeBase();
  const dir = await makeSession(base, 'sess-1', {
    files: ['u1.pcm', 'u2.pcm', 'u1.wav', 'transcript.json', 'mixed.m4a'],
  });

  const { deleted, freedBytes } = await deletePcmFiles(dir);
  expect(deleted).toBe(2);
  expect(freedBytes).toBe(32); // 16B × 2

  const left = (await readdir(dir)).sort();
  expect(left).toStrictEqual(['mixed.m4a', 'transcript.json', 'u1.wav']);
});

test('deletePcmFiles: pcm が無ければ何も消さない', async () => {
  const base = await makeBase();
  const dir = await makeSession(base, 'sess-1', { files: ['u1.wav'] });

  const { deleted } = await deletePcmFiles(dir);
  expect(deleted).toBe(0);
  expect(await readdir(dir)).toStrictEqual(['u1.wav']);
});

test('deletePcmFiles: 存在しないディレクトリでも throw しない(掃除失敗で本体を巻き込まない)', async () => {
  const base = await makeBase();
  const { deleted } = await deletePcmFiles(join(base, 'nope'));
  expect(deleted).toBe(0);
});

test('purgeOldSessions: 保持期間を過ぎたセッションだけ削除する', async () => {
  const base = await makeBase();
  await makeSession(base, 'old', { ageDays: 20 });
  await makeSession(base, 'fresh', { ageDays: 1 });

  const { deleted } = await purgeOldSessions(base, { retentionMs: 14 * DAY_MS });
  expect(deleted).toStrictEqual(['old']);
  expect(await readdir(base)).toStrictEqual(['fresh']);
});

test('purgeOldSessions: retentionMs=0 なら何も消さない(機能無効)', async () => {
  const base = await makeBase();
  await makeSession(base, 'old', { ageDays: 100 });

  const { deleted } = await purgeOldSessions(base, { retentionMs: 0 });
  expect(deleted).toStrictEqual([]);
  expect(await readdir(base)).toStrictEqual(['old']);
});

test('purgeOldSessions: keep のセッションは期限切れでも消さない(録音中の保護)', async () => {
  const base = await makeBase();
  await makeSession(base, 'recording-now', { ageDays: 30 });
  await makeSession(base, 'old', { ageDays: 30 });

  const { deleted } = await purgeOldSessions(base, {
    retentionMs: 14 * DAY_MS,
    keep: ['recording-now'],
  });
  expect(deleted).toStrictEqual(['old']);
  expect(await readdir(base)).toStrictEqual(['recording-now']);
});

test('purgeOldSessions: 解放バイト数を集計する', async () => {
  const base = await makeBase();
  await makeSession(base, 'old', { files: ['a.pcm', 'b.wav'], ageDays: 30 });

  const { freedBytes } = await purgeOldSessions(base, { retentionMs: 14 * DAY_MS });
  expect(freedBytes).toBe(32); // 16B × 2
});

test('purgeOldSessions: ベースディレクトリが無くても throw しない(初回起動)', async () => {
  const base = await makeBase();
  const { deleted } = await purgeOldSessions(join(base, 'missing'), { retentionMs: 14 * DAY_MS });
  expect(deleted).toStrictEqual([]);
});

test('purgeOldSessions: ディレクトリ以外のエントリは無視する', async () => {
  const base = await makeBase();
  await writeFile(join(base, 'stray.txt'), 'x');
  await makeSession(base, 'old', { ageDays: 30 });

  const { deleted } = await purgeOldSessions(base, { retentionMs: 14 * DAY_MS });
  expect(deleted).toStrictEqual(['old']);
  expect(await readdir(base)).toStrictEqual(['stray.txt']);
});

test('purgeOldSessions: now を注入して境界を検証する', async () => {
  const base = await makeBase();
  const dir = await makeSession(base, 'edge');
  const { mtimeMs } = await stat(dir);

  // ちょうど保持期間 = 残す
  let res = await purgeOldSessions(base, {
    retentionMs: 10 * DAY_MS,
    now: () => mtimeMs + 10 * DAY_MS,
  });
  expect(res.deleted).toStrictEqual([]);

  // 1ms でも超えたら消す
  res = await purgeOldSessions(base, {
    retentionMs: 10 * DAY_MS,
    now: () => mtimeMs + 10 * DAY_MS + 1,
  });
  expect(res.deleted).toStrictEqual(['edge']);
});

test('parseRetentionMs: 未設定・不正値は既定、0 は無効', () => {
  const def = DEFAULT_RETENTION_DAYS * DAY_MS;
  expect(parseRetentionMs(undefined)).toBe(def);
  expect(parseRetentionMs('')).toBe(def);
  expect(parseRetentionMs('abc')).toBe(def);
  expect(parseRetentionMs('-1')).toBe(def);
  expect(parseRetentionMs('0')).toBe(0);
  expect(parseRetentionMs('7')).toBe(7 * DAY_MS);
});

test('checkDiskSpace: 十分な空きがあれば警告しない', async () => {
  const base = await makeBase();
  const res = await checkDiskSpace(base, 1); // 閾値 1B
  expect(res.ok).toBe(true);
  expect(res.warning).toBe(null);
});

test('checkDiskSpace: 閾値を下回ると警告文を返す(録音はブロックしない)', async () => {
  const base = await makeBase();
  const res = await checkDiskSpace(base, Number.MAX_SAFE_INTEGER);
  expect(res.ok).toBe(false);
  expect(res.warning).toBeTruthy();
  expect(res.warning).toMatch(/空きが少なく/);
});

test('checkDiskSpace: 容量が読めなくても録音を止めない', async () => {
  const res = await checkDiskSpace('/nonexistent-path-for-test');
  expect(res.ok).toBe(true);
  expect(res.warning).toBe(null);
});

test('formatBytes: 単位を切り上げて読みやすく整形する', () => {
  expect(formatBytes(512)).toBe('512B');
  expect(formatBytes(1024)).toBe('1.0KB');
  expect(formatBytes(5 * 1024 ** 3)).toBe('5.0GB');
});
