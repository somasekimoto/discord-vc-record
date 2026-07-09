/**
 * join-prompt のユニットテスト:
 * 通知条件(対象VC・Bot除外・録音中スキップ・最初の入室者のみ・クールダウン)を検証する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JoinPromptNotifier, parsePromptChannelIds } from '../src/join-prompt.js';

const TARGET = 'vc-1';
const GUILD = 'guild-1';

/**
 * discord.js の VoiceState 相当の最小フェイクを組む。
 * others: 入室者以外の在室者。{ bot, resolved } で Bot / member未解決(キャッシュ漏れ)を表す。
 */
function makeStates({
  channelId = TARGET,
  oldChannelId = null,
  bot = false,
  others = [],
  sent = [],
} = {}) {
  const states = [
    { channelId, id: 'u0', member: { user: { bot } } }, // 入室者本人(イベント発火時点で在室扱い)
    ...others.map((o, i) => ({
      channelId,
      id: `u${i + 1}`,
      member: o.resolved === false ? null : { user: { bot: o.bot ?? false } },
    })),
  ];
  const cache = {
    filter: (fn) => {
      const arr = states.filter(fn);
      return { size: arr.length };
    },
  };
  const channel = {
    id: channelId,
    send: async (msg) => {
      sent.push(msg);
    },
  };
  const member = { user: { bot }, displayName: 'テスト太郎' };
  const guild = { id: GUILD, voiceStates: { cache } };
  const oldState = { channelId: oldChannelId, guild, member };
  const newState = { channelId, channel, guild, member, id: 'u0' };
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
  const { oldState, newState, sent } = makeStates({ others: [{}] });
  assert.equal(await notifier.handleVoiceState(oldState, newState), false);
  assert.equal(sent.length, 0);
});

test('member未解決(キャッシュ漏れ)の在室者がいる場合も投稿しない(誤通知より抑制に倒す)', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ others: [{ resolved: false }] });
  assert.equal(await notifier.handleVoiceState(oldState, newState), false);
  assert.equal(sent.length, 0);
});

test('在室者がBotだけなら最初の入室者として投稿する', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ others: [{ bot: true }] });
  assert.equal(await notifier.handleVoiceState(oldState, newState), true);
  assert.equal(sent.length, 1);
});

test('対象VCがキャッシュに無い場合は投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates();
  newState.channel = null;
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

test('send 失敗時は false を返し、クールダウンが戻って次の入室で再試行される', async () => {
  const nowValue = { t: 0 };
  const notifier = makeNotifier({ cooldownMs: 1000, nowValue });
  const first = makeStates();
  first.newState.channel.send = async () => {
    throw new Error('missing permission');
  };
  assert.equal(await notifier.handleVoiceState(first.oldState, first.newState), false);

  // 失敗した投稿はクールダウンを消費しない(一時的エラーで5分沈黙しない)
  nowValue.t = 1;
  const second = makeStates();
  assert.equal(await notifier.handleVoiceState(second.oldState, second.newState), true);
  assert.equal(second.sent.length, 1);
});

test('parsePromptChannelIds: カンマ区切り・空白・空要素を処理する', () => {
  assert.deepEqual(parsePromptChannelIds('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(parsePromptChannelIds(''), []);
  assert.deepEqual(parsePromptChannelIds(undefined), []);
});
