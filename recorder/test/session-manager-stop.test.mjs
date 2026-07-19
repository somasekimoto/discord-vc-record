/**
 * SessionManager.stop の競合テスト:
 * 停止経路(自動停止/ボタン/コマンド)が同時に stop を呼んでも、
 * 成功するのは先着の1つだけで pipeline が二重実行されないことを検証する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/recorder.js';

/** stop に時間がかかる録音セッションのフェイク。 */
function makeSlowSession() {
  let stopCalls = 0;
  return {
    get stopCalls() {
      return stopCalls;
    },
    stop: async () => {
      stopCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { id: 'sess-1' };
    },
    listTracks: async () => [{ userId: 'u1' }],
  };
}

test('stop の同時呼び出しは先着だけが成功し、後着は「進行中なし」で失敗する', async () => {
  const mgr = new SessionManager({ client: {}, baseDir: '/tmp' });
  const session = makeSlowSession();
  mgr.byGuild.set('g1', session);

  const [a, b] = await Promise.allSettled([mgr.stop('g1'), mgr.stop('g1')]);

  assert.equal(a.status, 'fulfilled');
  assert.equal(a.value.tracks.length, 1);
  assert.equal(b.status, 'rejected');
  assert.match(b.reason.message, /進行中の録音はありません/);
  assert.equal(session.stopCalls, 1); // セッション自体の stop も1回だけ
  assert.equal(mgr.byGuild.size, 0);
});

test('stop 中は get がセッションを返さない(status 表示や自動停止の誤作動防止)', async () => {
  const mgr = new SessionManager({ client: {}, baseDir: '/tmp' });
  mgr.byGuild.set('g1', makeSlowSession());

  const stopping = mgr.stop('g1');
  assert.equal(mgr.get('g1'), undefined); // await 前に登録が外れている
  await stopping;
});
