/**
 * join-prompt のユニットテスト:
 * 通知条件(対象VC・Bot除外・録音中スキップ・最初の入室者のみ・クールダウン)と、
 * 開始ボタン押下の分岐(VC未参加・別VC・録音中・正常系)を検証する。
 */
import type { VoiceEntry, VoiceStatePort, PromptPayload, MessageEdit, StartOptions } from '../src/ports.ts';
import type { InteractionReplyOptions } from 'discord.js';
import { expect, test } from 'vitest';
import {
  JoinPromptNotifier,
  parsePromptChannelIds,
  handleStartButton,
  buildStartComponents,
  START_BUTTON_PREFIX,
} from '../src/join-prompt.ts';

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
}: { channelId?: string; oldChannelId?: string | null; bot?: boolean; others?: { bot?: boolean; resolved?: boolean }[]; sent?: PromptPayload[] } = {}) {
  const states = [
    { channelId, id: 'u0', member: { user: { bot } } }, // 入室者本人(イベント発火時点で在室扱い)
    ...others.map((o, i) => ({
      channelId,
      id: `u${i + 1}`,
      member: o.resolved === false ? null : { user: { bot: o.bot ?? false } },
    })),
  ];
  const cache = {
    filter: (fn: (state: VoiceEntry) => boolean) => {
      const arr = states.filter(fn);
      return { size: arr.length };
    },
  };
  const channel = {
    id: channelId,
    send: async (msg: PromptPayload) => {
      sent.push(msg);
    },
  };
  const member = { user: { bot }, displayName: 'テスト太郎' };
  const guild = { id: GUILD, voiceStates: { cache } };
  const oldState = { channelId: oldChannelId, guild, member };
  const newState: VoiceStatePort = { channelId, channel, guild, member, id: 'u0' };
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
  expect(prompted).toBe(true);
  expect(sent.length).toBe(1);
  expect(sent[0].content!).toMatch(/\/rec start/);
  expect(sent[0].content!).toMatch(/テスト太郎/);
});

test('プロンプトには対象VCを customId に埋めた開始ボタンが付く', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates();
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(true);
  const buttons = sent[0].components[0].components;
  expect(buttons.length).toBe(1);
  expect(buttons[0].custom_id).toBe(`${START_BUTTON_PREFIX}:${TARGET}`);
});

test('対象外のVCへの入室では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ channelId: 'other-vc' });
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(false);
  expect(sent.length).toBe(0);
});

test('Botの入室では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ bot: true });
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(false);
  expect(sent.length).toBe(0);
});

test('同一VC内の状態変化(ミュート等)では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ oldChannelId: TARGET });
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(false);
  expect(sent.length).toBe(0);
});

test('録音中は投稿しない', async () => {
  const notifier = makeNotifier({ recording: true });
  const { oldState, newState, sent } = makeStates();
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(false);
  expect(sent.length).toBe(0);
});

test('既に他の人がいるVCへの入室では投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ others: [{}] });
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(false);
  expect(sent.length).toBe(0);
});

test('member未解決(キャッシュ漏れ)の在室者がいる場合も投稿しない(誤通知より抑制に倒す)', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ others: [{ resolved: false }] });
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(false);
  expect(sent.length).toBe(0);
});

test('在室者がBotだけなら最初の入室者として投稿する', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates({ others: [{ bot: true }] });
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(true);
  expect(sent.length).toBe(1);
});

test('対象VCがキャッシュに無い場合は投稿しない', async () => {
  const notifier = makeNotifier();
  const { oldState, newState, sent } = makeStates();
  newState.channel = null;
  expect(await notifier.handleVoiceState(oldState, newState)).toBe(false);
  expect(sent.length).toBe(0);
});

test('クールダウン中は再投稿せず、経過後は再び投稿する', async () => {
  const nowValue = { t: 0 };
  const notifier = makeNotifier({ cooldownMs: 1000, nowValue });
  const first = makeStates();
  expect(await notifier.handleVoiceState(first.oldState, first.newState)).toBe(true);

  nowValue.t = 999; // クールダウン内
  const second = makeStates();
  expect(await notifier.handleVoiceState(second.oldState, second.newState)).toBe(false);

  nowValue.t = 1000; // クールダウン経過
  const third = makeStates();
  expect(await notifier.handleVoiceState(third.oldState, third.newState)).toBe(true);
});

test('send 失敗時は false を返し、クールダウンが戻って次の入室で再試行される', async () => {
  const nowValue = { t: 0 };
  const notifier = makeNotifier({ cooldownMs: 1000, nowValue });
  const first = makeStates();
  first.newState.channel!.send = async () => {
    throw new Error('missing permission');
  };
  expect(await notifier.handleVoiceState(first.oldState, first.newState)).toBe(false);

  // 失敗した投稿はクールダウンを消費しない(一時的エラーで5分沈黙しない)
  nowValue.t = 1;
  const second = makeStates();
  expect(await notifier.handleVoiceState(second.oldState, second.newState)).toBe(true);
  expect(second.sent.length).toBe(1);
});

/** 開始ボタン押下 interaction のフェイク。 */
function makeStartInteraction({
  channelId = TARGET,
  userVoiceChannelId = TARGET,
  guildId = GUILD,
}: { channelId?: string; userVoiceChannelId?: string | null; guildId?: string } = {}) {
  const calls: { replies: InteractionReplyOptions[]; messageEdits: MessageEdit[]; deferrals: number } = { replies: [], messageEdits: [], deferrals: 0 };
  return {
    customId: `${START_BUTTON_PREFIX}:${channelId}`,
    guildId,
    channelId: 'text-in-voice',
    user: { id: 'u0' },
    member: { voice: { channelId: userVoiceChannelId } },
    calls,
    deferUpdate: async () => {
      calls.deferrals += 1;
    },
    reply: async (p: InteractionReplyOptions) => calls.replies.push(p),
    message: { edit: async (p: MessageEdit) => calls.messageEdits.push(p) },
  };
}

/** startSession のフェイク。starts に呼び出し引数を記録する。 */
function makeStartDeps({ recording = false, fail = null }: { recording?: boolean; fail?: string | null } = {}) {
  const starts: StartOptions[] = [];
  return {
    starts,
    sessions: { get: () => (recording ? {} : undefined) },
    startSession: async (opts: StartOptions) => {
      starts.push(opts);
      if (fail) throw new Error(fail);
      return { id: 'sess-1' };
    },
  };
}

test('開始ボタン: 押下で録音が開始され、メッセージが更新されてボタンが消える', async () => {
  const deps = makeStartDeps();
  const interaction = makeStartInteraction();
  expect(await handleStartButton(interaction, deps)).toBe(true);

  expect(deps.starts.length).toBe(1);
  expect(deps.starts[0].channelId).toBe(TARGET);
  expect(deps.starts[0].startedByUserId).toBe('u0');
  // 自動停止の通知先はボタンが置かれたチャンネル
  expect(deps.starts[0].notifyChannelId).toBe('text-in-voice');

  const edit = interaction.calls.messageEdits[0];
  expect(edit.content!).toMatch(/録音を開始しました/);
  expect(edit.content!).toMatch(/sess-1/);
  expect(edit.components).toStrictEqual([]);
});

test('開始ボタン: VCに参加していない場合は開始せず ephemeral で促す', async () => {
  const deps = makeStartDeps();
  const interaction = makeStartInteraction({ userVoiceChannelId: null });
  expect(await handleStartButton(interaction, deps)).toBe(false);

  expect(deps.starts.length).toBe(0);
  expect(interaction.calls.replies[0].content!).toMatch(/先にVCに参加/);
});

test('開始ボタン: 押した人が別のVCにいる場合は開始しない', async () => {
  const deps = makeStartDeps();
  const interaction = makeStartInteraction({ userVoiceChannelId: 'other-vc' });
  expect(await handleStartButton(interaction, deps)).toBe(false);

  expect(deps.starts.length).toBe(0);
  expect(interaction.calls.replies[0].content!).toMatch(/別のVC/);
});

test('開始ボタン: 既に録音中なら二重開始せず、古いボタンを剥がす', async () => {
  const deps = makeStartDeps({ recording: true });
  const interaction = makeStartInteraction();
  expect(await handleStartButton(interaction, deps)).toBe(false);

  expect(deps.starts.length).toBe(0);
  expect(interaction.calls.replies[0].content!).toMatch(/既に録音中/);
  expect(interaction.calls.messageEdits[0]).toStrictEqual({ components: [] });
});

test('開始ボタン: 開始処理が失敗したら ephemeral で表面化する', async () => {
  const deps = makeStartDeps({ fail: '既に録音中です' });
  const interaction = makeStartInteraction();
  expect(await handleStartButton(interaction, deps)).toBe(false);

  expect(interaction.calls.replies[0].content!).toMatch(/開始できませんでした/);
  expect(interaction.calls.replies[0].content!).toMatch(/既に録音中です/);
  expect(interaction.calls.messageEdits.length).toBe(0); // 成功時のみ書き換える
});

test('buildStartComponents は channelId を customId に埋める', () => {
  const [row] = buildStartComponents('vc-9');
  expect(row.type).toBe(1);
  expect(row.components[0].custom_id).toBe(`${START_BUTTON_PREFIX}:vc-9`);
});

test('parsePromptChannelIds: カンマ区切り・空白・空要素を処理する', () => {
  expect(parsePromptChannelIds('a, b ,,c')).toStrictEqual(['a', 'b', 'c']);
  expect(parsePromptChannelIds('')).toStrictEqual([]);
  expect(parsePromptChannelIds(undefined)).toStrictEqual([]);
});
