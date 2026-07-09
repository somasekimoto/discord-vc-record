/**
 * join-prompt のユニットテスト:
 * 通知条件(対象VC・Bot除外・録音中スキップ・最初の入室者のみ・クールダウン)を検証する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JoinPromptNotifier, parsePromptChannelIds } from '../src/join-prompt.js';

const TARGET = 'vc-1';
const GUILD = 'guild-1';

/** discord.js の VoiceState 相当の最小フェイクを組む */
function makeStates({
  channelId = TARGET,
  oldChannelId = null,
  bot = false,
  memberCount = 1, // 入室後の VC 内の人間の数(本人含む)
  sent = [],
} = {}) {
  const humans = Array.from({ length: memberCount }, (_, i) => ({ user: { bot: false }, id: `u${i}` }));
  const members = {
    filter: (fn) => {
      const arr = humans.filter(fn);
      return { size: arr.length };
    },
  };
  const channel = {
    id: channelId,
    members,
    send: async (msg) => {
      sent.push(msg);
    },
  };
  const member = { user: { bot }, displayName: 'テスト太郎' };
  const oldState = { channelId: oldChannelId, guild: { id: GUILD }, member };
  const newState = { channelId, channel, guild: { id: GUILD }, member, id: 'u0' };
  return { oldState, newState, sent };
}

function makeNotifier({ recording = false, cooldownMs = 1000, nowValue = { t: 0 } } = {}) {
  const sessions = { get: () => (recording ? {} : undefined) };
  return new JoinPromptNotifier({
    channelIds: [TARGET],
    sessions,
    cooldownMs,
    now: () => nowValue.t,
  });
}

test('対象VCへの入室で録音開始を促すメッセージが投稿される', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates();
  const prompted = await notifier.handleVoiceState(oldState, newState);
  assert.equal(prompted, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\/rec start/);
  assert.match(sent[0], /テスト太郎/);
});

test('対象外のVCへの入室では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ channelId: 'other-vc' });
  assert.equal(await notifier.handleVoiceState(oldState, newState), false);
  assert.equal(sent.length, 0);
});

test('Botの入室では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ bot: true });
  assert.equal(await notifier.handleVoiceState(oldState, newState), false);
  assert.equal(sent.length, 0);
});

test('同一VC内の状態変化(ミュート等)では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ oldChannelId: TARGET });
  assert.equal(await notifier.handleVoiceState(oldState, newState), false);
  assert.equal(sent.length, 0);
});

test('録音中は投稿しない', async () => {
  const notifier = makeNotifier({ recording: true });
  const { oldState, newState, sent } = makeStates();
  assert.equal(await notifier.handleVoiceState(oldState, newState), false);
  assert.equal(sent.length, 0);
});

test('既に他の人がいるVCへの入室では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ memberCount: 2 });
  assert.equal(await notifier.handleVoiceState(oldState, newState), false);
  assert.equal(sent.length, 0);
});

test('クールダウン中は再投稿せず、経過後は再び投稿する', async () => {
  const nowValue = { t: 0 };
  const notifier = makeNotifier({ cooldownMs: 1000, nowValue });
  const first = makeStates();
  assert.equal(await notifier.handleVoiceState(first.oldState, first.newState), true);

  nowValue.t = 999; // クールダウン内
  const second = makeStates();
  assert.equal(await notifier.handleVoiceState(second.oldState, second.newState), false);

  nowValue.t = 1000; // クールダウン経過
  const third = makeStates();
  assert.equal(await notifier.handleVoiceState(third.oldState, third.newState), true);
});

test('send が失敗しても例外を投げない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState } = makeStates();
  newState.channel.send = async () => {
    throw new Error('missing permission');
  };
  // 投稿を試みたので true(クールダウンは記録される)
  assert.equal(await notifier.handleVoiceState(oldState, newState), true);
});

test('parsePromptChannelIds: カンマ区切り・空白・空要素を処理する', () => {
  assert.deepEqual(parsePromptChannelIds('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(parsePromptChannelIds(''), []);
  assert.deepEqual(parsePromptChannelIds(undefined), []);
});
