/**
 * SessionManager.stop の競合テスト:
 * 停止経路(自動停止/ボタン/コマンド)が同時に stop を呼んでも、
 * 成功するのは先着の1つだけで pipeline が二重実行されないことを検証する。
 */
import { assert, expect, test } from 'vitest';
import { Client } from 'discord.js';
import { SessionManager, NoActiveSessionError, RecordingSession } from '../src/recorder.ts';

/** stop に時間がかかる録音セッションのフェイク。 */
function makeSlowSession() {
  let stopCalls = 0;
  class SlowSession extends RecordingSession {
    get stopCalls() {
      return stopCalls;
    }
    override async stop() {
      stopCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return this._summary();
    }
    override async listTracks() { return [{ userId: 'u1', displayName: 'u1', pcmPath: '/tmp/u1.pcm', bytes: 1, durationSec: 1, utterances: [] }]; }
  }
  const session = new SlowSession({ client: new Client({ intents: [] }), baseDir: '/tmp', guildId: 'g1', channelId: 'c1', startedByUserId: 'u1' });
  session.id = 'sess-1';
  return session;
}

test('stop の同時呼び出しは先着だけが成功し、後着は「進行中なし」で失敗する', async () => {
  const mgr = new SessionManager({ client: new Client({ intents: [] }), baseDir: '/tmp' });
  const session = makeSlowSession();
  mgr.byGuild.set('g1', session);

  const [a, b] = await Promise.allSettled([mgr.stop('g1'), mgr.stop('g1')]);

  assert(a.status === 'fulfilled');
  expect(a.value.tracks.length).toBe(1);
  assert(b.status === 'rejected');
  expect(b.reason).toBeInstanceOf(NoActiveSessionError); // 競合負けは typed error で判定できる
  expect(b.reason.message).toMatch(/進行中の録音はありません/);
  expect(session.stopCalls).toBe(1); // セッション自体の stop も1回だけ
  expect(mgr.byGuild.size).toBe(0);
});

test('未開始セッションの stop は nullable な旧 snapshot を返す', async () => {
  const session = new RecordingSession({ client: new Client({ intents: [] }), baseDir: '/tmp', guildId: 'g1', channelId: 'c1', startedByUserId: 'u1' });
  const summary = await session.stop();
  expect(summary.startedAt).toBe(null);
  expect(summary.endedAt).toBe(null);
  expect(session.status).toBe('idle');
  expect(summary.startedByUserId).toBe('u1');
  expect('startedBy' in summary).toBe(false);
});

test('stop 中は get がセッションを返さない(status 表示や自動停止の誤作動防止)', async () => {
  const mgr = new SessionManager({ client: new Client({ intents: [] }), baseDir: '/tmp' });
  mgr.byGuild.set('g1', makeSlowSession());

  const stopping = mgr.stop('g1');
  expect(mgr.get('g1')).toBe(undefined); // await 前に登録が外れている
  await stopping;
});
