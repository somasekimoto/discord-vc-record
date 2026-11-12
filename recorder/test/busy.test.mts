/**
 * BusyTracker: 自動デプロイが「録音中・文字起こし中は再起動しない」と判断する材料。
 */
import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusyTracker } from '../src/busy.ts';

function setup(sessions: { n: number }) {
  const path = join(mkdtempSync(join(tmpdir(), 'busy-')), 'busy.json');
  const tracker = new BusyTracker({ path, countSessions: () => sessions.n, now: () => new Date('2026-11-12T00:00:00Z') });
  const read = () => JSON.parse(readFileSync(path, 'utf8'));
  return { tracker, read };
}

test('セッション数をそのまま書き出す', () => {
  const sessions = { n: 0 };
  const { tracker, read } = setup(sessions);
  tracker.write();
  expect(read()).toEqual({ sessions: 0, pipelines: 0, updatedAt: '2026-11-12T00:00:00.000Z' });
  sessions.n = 1;
  tracker.write();
  expect(read().sessions).toBe(1);
});

test('pipeline の実行中は数え、成功しても失敗しても終了後に 0 へ戻す', async () => {
  const { tracker, read } = setup({ n: 0 });
  let during = -1;
  await tracker.trackPipeline(async () => {
    during = read().pipelines;
  });
  expect(during).toBe(1);
  expect(read().pipelines).toBe(0);

  await expect(
    tracker.trackPipeline(async () => {
      throw new Error('stt failed');
    }),
  ).rejects.toThrow('stt failed');
  expect(read().pipelines).toBe(0);
});

test('書き出せない場所でも例外を投げない(録音を止めない)', () => {
  const tracker = new BusyTracker({ path: '/nonexistent-dir/busy.json', countSessions: () => 0 });
  expect(() => tracker.write()).not.toThrow();
});
