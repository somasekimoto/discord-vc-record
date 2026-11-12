/**
 * BusyTracker: 自動デプロイが「録音中・文字起こし中は再起動しない」と判断する材料。
 */
import { expect, onTestFinished, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Client } from 'discord.js';
import { SessionManager, RecordingSession } from '../src/recorder.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusyTracker } from '../src/busy.ts';

function setup(sessions: { n: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'busy-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'busy.json');
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

test('予約は停止直後から数え、run の終了で戻す', async () => {
  const { tracker, read } = setup({ n: 0 });
  const r = tracker.reserve();
  expect(read().pipelines).toBe(1); // 停止〜pipeline 開始の間も busy
  await r.run(async () => {
    expect(read().pipelines).toBe(1);
  });
  expect(read().pipelines).toBe(0);
  r.release(); // 二重に戻さない
  expect(read().pipelines).toBe(0);
});

test('run されない予約は一定時間で自動解除され、デプロイを待たせ続けない', () => {
  vi.useFakeTimers();
  try {
    const { tracker, read } = setup({ n: 0 });
    tracker.reserve(1000);
    expect(read().pipelines).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(read().pipelines).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('SessionManager は VC 接続の完了を待つ前に登録を知らせる(接続中も busy)', async () => {
  let release!: () => void;
  class SlowStart extends RecordingSession {
    override async start() {
      await new Promise<void>((r) => { release = r; });
      return 'sess';
    }
  }
  const counts: number[] = [];
  const mgr = new SessionManager({ client: new Client({ intents: [] }), baseDir: '/tmp', onChange: () => counts.push(mgr.byGuild.size) });
  // start() は RecordingSession を内部で作るので、生成をすり替える
  const origSet = mgr.byGuild.set.bind(mgr.byGuild);
  mgr.byGuild.set = (k, v) => origSet(k, Object.setPrototypeOf(v, SlowStart.prototype));
  const p = mgr.start({ guildId: 'g1', channelId: 'c1', startedByUserId: 'u1' });
  await new Promise((r) => setTimeout(r, 0));
  expect(counts).toEqual([1]); // まだ接続中
  release();
  await p;
});
