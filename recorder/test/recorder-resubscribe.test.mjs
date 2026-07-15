/**
 * recorder-resubscribe.test.mjs — ストリームエラー後の再購読(録音継続)の回帰テスト
 *
 * 背景: @discordjs/voice は受信パケットの復号失敗(DAVE のエポック遷移中など)で
 * 購読ストリームを destroy(error) する。修正前の recorder は activeStreams から
 * ユーザーを削除しなかったため、一度ストリームが死んだユーザーはセッション終了まで
 * 二度と購読されず、「録音開始前から VC にいた人の声が丸ごと欠ける」不具合になった。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingSession } from '../src/recorder.js';

/** VC 接続なしでセッションを録音中状態にし、receiver を偽物に差し替える。 */
async function makeSession() {
  const baseDir = await mkdtemp(join(tmpdir(), 'rec-test-'));
  const session = new RecordingSession({
    client: {},
    guildId: 'g1',
    channelId: 'c1',
    startedByUserId: 'starter',
    baseDir,
  });
  await mkdir(session.dir, { recursive: true });
  session.startedAt = Date.now();
  session.status = 'recording';

  const subscribed = []; // subscribe が返した opus ストリーム(発生順)
  const speaking = new EventEmitter();
  speaking.users = new Map(); // SpeakingMap 互換: 現在発話中のユーザー
  session.receiver = {
    speaking,
    subscribe: () => {
      const s = new PassThrough();
      subscribed.push(s);
      return s;
    },
  };
  return { session, subscribed };
}

test('ストリームエラー後、次の speaking start で再購読され録音が継続する', async () => {
  const { session, subscribed } = await makeSession();

  session._onSpeakingStart('user1');
  assert.equal(subscribed.length, 1, '最初の speaking start で購読される');
  const st = session.trackStates.get('user1');
  assert.ok(st, 'トラック state が作られる');

  // DAVE 復号失敗 → ライブラリが stream.destroy(error) するのを再現
  subscribed[0].destroy(new Error('decrypt failed'));
  await Promise.allSettled([...session.pendingPipelines]);

  assert.equal(session.activeStreams.has('user1'), false, 'エラー後は再購読可能に戻る');
  assert.equal(session.subscriptions.has('user1'), false, '死んだ購読は破棄される');

  // 次の発話バーストで再購読される
  session._onSpeakingStart('user1');
  assert.equal(subscribed.length, 2, 'エラー後の speaking start で再購読される');
  assert.strictEqual(
    session.trackStates.get('user1'),
    st,
    '再購読でトラック state(bytes/utterances)がリセットされない',
  );

  await session.stop();
});

test('タイマー発火前に本物の speaking start が来ても二重購読しない', async () => {
  const { session, subscribed } = await makeSession();

  session._onSpeakingStart('user1');
  session.receiver.speaking.users.set('user1', Date.now());

  subscribed[0].destroy(new Error('decrypt failed'));
  await Promise.allSettled([...session.pendingPipelines]);

  // 再購読タイマー(200ms)より先に本物の speaking start が到着
  session._onSpeakingStart('user1');
  assert.equal(subscribed.length, 2);

  // タイマーが発火しても activeStreams ガードにより追加購読されない
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(subscribed.length, 2, 'タイマー発火で二重購読されない');

  await session.stop();
});

test('発話途中でストリームが死んだら区間を閉じ、無記録ギャップを区間内に含めない', async () => {
  const { session, subscribed } = await makeSession();

  session._onSpeakingStart('user1');
  const st = session.trackStates.get('user1');
  assert.ok(st.current, '発話区間が開いている');

  subscribed[0].destroy(new Error('decrypt failed'));
  await Promise.allSettled([...session.pendingPipelines]);

  assert.equal(st.current, null, 'エラー時点で発話区間が閉じられる');
  assert.equal(st.utterances.length, 1, '閉じた区間は utterances に記録される');
  assert.equal(st.streamErrors, 1, '連続失敗カウンタが増える');

  // 復旧後の発話は新しい区間として開く(ギャップは区間の隙間になる)
  session._onSpeakingStart('user1');
  assert.ok(st.current, '再購読後は新しい発話区間が開く');

  await session.stop();
});

test('再購読時に st.bytes が実ファイルサイズへ再同期される', async () => {
  const { session, subscribed } = await makeSession();

  session._onSpeakingStart('user1');
  const st = session.trackStates.get('user1');

  subscribed[0].destroy(new Error('decrypt failed'));
  await Promise.allSettled([...session.pendingPipelines]);

  // エラー destroy で書き込みバッファが捨てられ、bytes が実ファイルより先行した状態を再現
  st.bytes = 999_999;

  session._onSpeakingStart('user1');
  assert.equal(st.bytes, 0, '実ファイルサイズ(未書き込み=0)へ再同期される');

  await session.stop();
});

test('データが流れると連続失敗カウンタがリセットされる', async () => {
  const { session, subscribed } = await makeSession();

  session._onSpeakingStart('user1');
  const st = session.trackStates.get('user1');

  subscribed[0].destroy(new Error('decrypt failed'));
  await Promise.allSettled([...session.pendingPipelines]);
  assert.equal(st.streamErrors, 1);

  // 再購読して有効な opus データ(Discord の無音フレーム)を流す
  session._onSpeakingStart('user1');
  subscribed[1].write(Buffer.from([0xf8, 0xff, 0xfe]));
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(st.bytes > 0, 'デコード済み PCM のバイト数が数えられる');
  assert.equal(st.streamErrors, 0, 'データが流れたらカウンタが 0 に戻る');

  await session.stop();
});

test('本人が発話中のままストリームが死んだ場合は自動で再購読される', async () => {
  const { session, subscribed } = await makeSession();

  session._onSpeakingStart('user1');
  // SpeakingMap 上はまだ発話中(パケットは届き続けている)
  session.receiver.speaking.users.set('user1', Date.now());

  subscribed[0].destroy(new Error('decrypt failed'));
  await Promise.allSettled([...session.pendingPipelines]);

  // 再購読は 200ms 後に行われる
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(subscribed.length, 2, '発話中なら speaking start を待たずに再購読される');
  assert.equal(session.activeStreams.has('user1'), true);

  await session.stop();
});

test('stop 中のストリーム終了では再購読しない', async () => {
  const { session, subscribed } = await makeSession();

  session._onSpeakingStart('user1');
  session.receiver.speaking.users.set('user1', Date.now());

  await session.stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(subscribed.length, 1, 'stop 後に再購読されない');
});
