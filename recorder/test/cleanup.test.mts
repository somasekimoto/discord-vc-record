/**
 * cleanup のユニットテスト:
 * PCM 削除・保持期間による一括削除・空き容量チェックを実ファイルで検証する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(deleted, 2);
  assert.equal(freedBytes, 32); // 16B × 2

  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, ['mixed.m4a', 'transcript.json', 'u1.wav']);
});

test('deletePcmFiles: pcm が無ければ何も消さない', async () => {
  const base = await makeBase();
  const dir = await makeSession(base, 'sess-1', { files: ['u1.wav'] });

  const { deleted } = await deletePcmFiles(dir);
  assert.equal(deleted, 0);
  assert.deepEqual(await readdir(dir), ['u1.wav']);
});

test('deletePcmFiles: 存在しないディレクトリでも throw しない(掃除失敗で本体を巻き込まない)', async () => {
  const base = await makeBase();
  const { deleted } = await deletePcmFiles(join(base, 'nope'));
  assert.equal(deleted, 0);
});

test('purgeOldSessions: 保持期間を過ぎたセッションだけ削除する', async () => {
  const base = await makeBase();
  await makeSession(base, 'old', { ageDays: 20 });
  await makeSession(base, 'fresh', { ageDays: 1 });

  const { deleted } = await purgeOldSessions(base, { retentionMs: 14 * DAY_MS });
  assert.deepEqual(deleted, ['old']);
  assert.deepEqual(await readdir(base), ['fresh']);
});

test('purgeOldSessions: retentionMs=0 なら何も消さない(機能無効)', async () => {
  const base = await makeBase();
  await makeSession(base, 'old', { ageDays: 100 });

  const { deleted } = await purgeOldSessions(base, { retentionMs: 0 });
  assert.deepEqual(deleted, []);
  assert.deepEqual(await readdir(base), ['old']);
});

test('purgeOldSessions: keep のセッションは期限切れでも消さない(録音中の保護)', async () => {
  const base = await makeBase();
  await makeSession(base, 'recording-now', { ageDays: 30 });
  await makeSession(base, 'old', { ageDays: 30 });

  const { deleted } = await purgeOldSessions(base, {
    retentionMs: 14 * DAY_MS,
    keep: ['recording-now'],
  });
  assert.deepEqual(deleted, ['old']);
  assert.deepEqual(await readdir(base), ['recording-now']);
});

test('purgeOldSessions: 解放バイト数を集計する', async () => {
  const base = await makeBase();
  await makeSession(base, 'old', { files: ['a.pcm', 'b.wav'], ageDays: 30 });

  const { freedBytes } = await purgeOldSessions(base, { retentionMs: 14 * DAY_MS });
  assert.equal(freedBytes, 32); // 16B × 2
});

test('purgeOldSessions: ベースディレクトリが無くても throw しない(初回起動)', async () => {
  const base = await makeBase();
  const { deleted } = await purgeOldSessions(join(base, 'missing'), { retentionMs: 14 * DAY_MS });
  assert.deepEqual(deleted, []);
});

test('purgeOldSessions: ディレクトリ以外のエントリは無視する', async () => {
  const base = await makeBase();
  await writeFile(join(base, 'stray.txt'), 'x');
  await makeSession(base, 'old', { ageDays: 30 });

  const { deleted } = await purgeOldSessions(base, { retentionMs: 14 * DAY_MS });
  assert.deepEqual(deleted, ['old']);
  assert.deepEqual(await readdir(base), ['stray.txt']);
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
  assert.deepEqual(res.deleted, []);

  // 1ms でも超えたら消す
  res = await purgeOldSessions(base, {
    retentionMs: 10 * DAY_MS,
    now: () => mtimeMs + 10 * DAY_MS + 1,
  });
  assert.deepEqual(res.deleted, ['edge']);
});

test('parseRetentionMs: 未設定・不正値は既定、0 は無効', () => {
  const def = DEFAULT_RETENTION_DAYS * DAY_MS;
  assert.equal(parseRetentionMs(undefined), def);
  assert.equal(parseRetentionMs(''), def);
  assert.equal(parseRetentionMs('abc'), def);
  assert.equal(parseRetentionMs('-1'), def);
  assert.equal(parseRetentionMs('0'), 0);
  assert.equal(parseRetentionMs('7'), 7 * DAY_MS);
});

test('checkDiskSpace: 十分な空きがあれば警告しない', async () => {
  const base = await makeBase();
  const res = await checkDiskSpace(base, 1); // 閾値 1B
  assert.equal(res.ok, true);
  assert.equal(res.warning, null);
});

test('checkDiskSpace: 閾値を下回ると警告文を返す(録音はブロックしない)', async () => {
  const base = await makeBase();
  const res = await checkDiskSpace(base, Number.MAX_SAFE_INTEGER);
  assert.equal(res.ok, false);
  assert.ok(res.warning);
  assert.match(res.warning, /空きが少なく/);
});

test('checkDiskSpace: 容量が読めなくても録音を止めない', async () => {
  const res = await checkDiskSpace('/nonexistent-path-for-test');
  assert.equal(res.ok, true);
  assert.equal(res.warning, null);
});

test('formatBytes: 単位を切り上げて読みやすく整形する', () => {
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(1024), '1.0KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0GB');
});
