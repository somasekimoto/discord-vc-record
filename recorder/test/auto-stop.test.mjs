/**
 * auto-stop のユニットテスト:
 * 無人検知(Bot除外・member未解決の扱い)、猶予タイマー、ボタン(即終了/延長)、
 * 再入室キャンセル、二重停止防止、外部停止時の後片付けを検証する。
 * タイマーは注入したフェイクで手動発火させる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoStopController,
  buildPromptComponents,
  parseEmptyDelayMs,
  DEFAULT_EMPTY_DELAY_MS,
  EXTEND_MINUTES,
} from '../src/auto-stop.js';

const GUILD = 'guild-1';
const VC = 'vc-1';
const TEXT = 'text-1';
const SESSION_ID = 'sess-1';

/** 手動発火できるフェイクタイマー。 */
function makeTimers() {
  let nextId = 1;
  const pending = new Map(); // id -> { fn, ms }
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id);
    },
    /** 登録済みタイマーを1つ発火させる(完了まで待つ)。 */
    async fire(id) {
      const t = pending.get(id);
      assert.ok(t, `timer ${id} is not pending`);
      pending.delete(id);
      await t.fn();
    },
    pending,
  };
}

/**
 * コントローラと discord.js 相当の最小フェイク一式を組む。
 * vcMembers: VC の初期在室者 [{ id, bot, resolved }]
 */
function makeHarness({ emptyDelayMs = 60_000, vcMembers = [] } = {}) {
  // voiceStates.cache 相当。leave/join ヘルパで書き換える
  const voiceEntries = vcMembers.map((m, i) => ({
    channelId: VC,
    id: m.id ?? `u${i}`,
    member: m.resolved === false ? null : { user: { bot: m.bot ?? false } },
  }));
  const guild = {
    id: GUILD,
    voiceStates: {
      cache: {
        filter: (fn) => {
          const arr = voiceEntries.filter(fn);
          return { size: arr.length };
        },
      },
    },
  };

  const sent = []; // channel.send されたプロンプトメッセージ
  const channel = {
    send: async (payload) => {
      const message = { payload, edits: [], edit: async (p) => message.edits.push(p) };
      sent.push(message);
      return message;
    },
  };

  const session = { id: SESSION_ID, channelId: VC, notifyChannelId: TEXT };
  const sessionsMap = new Map([[GUILD, session]]);
  const stops = [];
  const timers = makeTimers();

  const controller = new AutoStopController({
    sessions: { get: (g) => sessionsMap.get(g) },
    emptyDelayMs,
    timers,
    fetchChannel: async () => channel,
    getGuild: (g) => (g === GUILD ? guild : undefined),
    stop: async (guildId, reason) => {
      stops.push({ guildId, reason });
      sessionsMap.delete(guildId); // 実装同様、停止でセッションは消える
    },
  });

  const makeState = (channelId, { bot = false, resolved = true } = {}) => ({
    channelId,
    guild,
    member: resolved ? { user: { bot } } : null,
  });

  return {
    controller,
    timers,
    sent,
    stops,
    session,
    sessionsMap,
    voiceEntries,
    /** userId が VC から退出したことにしてイベントを流す。 */
    async leave(userId, opts = {}) {
      const idx = voiceEntries.findIndex((e) => e.id === userId);
      if (idx >= 0) voiceEntries.splice(idx, 1);
      await controller.handleVoiceState(
        { ...makeState(VC, opts), id: userId },
        { ...makeState(null, opts), id: userId },
      );
    },
    /** userId が VC に入室したことにしてイベントを流す。 */
    async join(userId, opts = {}) {
      voiceEntries.push({
        channelId: VC,
        id: userId,
        member: opts.resolved === false ? null : { user: { bot: opts.bot ?? false } },
      });
      await controller.handleVoiceState(
        { ...makeState(null, opts), id: userId },
        { ...makeState(VC, opts), id: userId },
      );
    },
    /** 進行中の確認状態のタイマーを発火させる。 */
    async fireTimer() {
      const state = controller.states.get(GUILD);
      assert.ok(state, 'no pending auto-stop state');
      await timers.fire(state.timer);
    },
  };
}

/** ボタン押下 interaction のフェイク。 */
function makeButtonInteraction(customId, { guildId = GUILD } = {}) {
  const calls = { updates: [], replies: [], messageEdits: [] };
  return {
    customId,
    guildId,
    calls,
    update: async (p) => calls.updates.push(p),
    reply: async (p) => calls.replies.push(p),
    message: { edit: async (p) => calls.messageEdits.push(p) },
  };
}

test('最後の1人が退出するとボタン付きプロンプトが投稿され、猶予経過で停止する', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].payload.content, /無人になりました/);
  assert.match(h.sent[0].payload.content, /60秒/);
  const buttons = h.sent[0].payload.components[0].components;
  assert.equal(buttons.length, 1 + EXTEND_MINUTES.length); // すぐ終了 + 延長プリセット
  assert.equal(buttons[0].custom_id, `autostop:stop:${SESSION_ID}`);

  assert.equal(h.stops.length, 0); // 猶予中はまだ停止しない
  await h.fireTimer();
  assert.deepEqual(h.stops, [{ guildId: GUILD, reason: 'auto' }]);
  assert.match(h.sent[0].edits[0].content, /自動終了しました/);
  assert.deepEqual(h.sent[0].edits[0].components, []); // ボタン無効化
});

test('Botだけが残った場合も無人として扱う', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }, { id: 'bot1', bot: true }] });
  await h.leave('u1');
  assert.equal(h.sent.length, 1);
});

test('member未解決の在室者が残っている場合は人間扱いし停止しない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }, { id: 'u2', resolved: false }] });
  await h.leave('u1');
  assert.equal(h.sent.length, 0);
  assert.equal(h.controller.states.size, 0);
});

test('録音対象外のVCの退出には反応しない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  // 別VCからの退出イベント(録音VCには u1 が残っている)
  await h.controller.handleVoiceState(
    { channelId: 'vc-other', guild: { id: GUILD }, member: { user: { bot: false } }, id: 'u9' },
    { channelId: null, guild: { id: GUILD }, member: { user: { bot: false } }, id: 'u9' },
  );
  assert.equal(h.sent.length, 0);
});

test('録音していないギルドのイベントは無視する', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.controller.handleVoiceState(
    { channelId: VC, guild: { id: 'guild-other' }, member: { user: { bot: false } }, id: 'u1' },
    { channelId: null, guild: { id: 'guild-other' }, member: { user: { bot: false } }, id: 'u1' },
  );
  assert.equal(h.sent.length, 0);
});

test('カウントダウン中に再入室するとキャンセルされ停止しない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  const state = h.controller.states.get(GUILD);
  await h.join('u1');

  assert.equal(h.controller.states.size, 0);
  assert.equal(h.timers.pending.has(state.timer), false); // タイマー解除
  assert.match(h.sent[0].edits[0].content, /戻ったため/);
  assert.equal(h.stops.length, 0);
});

test('退出イベントが連続しても確認中はプロンプトを重複投稿しない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  await h.leave('u1'); // 同じ退出が二重配送された想定
  assert.equal(h.sent.length, 1);
});

test('「すぐ終了」ボタンで即停止しタイマーが解除される', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  const state = h.controller.states.get(GUILD);

  const interaction = makeButtonInteraction(`autostop:stop:${SESSION_ID}`);
  await h.controller.handleButton(interaction);

  assert.deepEqual(h.stops, [{ guildId: GUILD, reason: 'button' }]);
  assert.equal(h.timers.pending.has(state.timer), false);
  assert.match(interaction.calls.updates[0].content, /終了します/);
  assert.deepEqual(interaction.calls.updates[0].components, []);
});

test('延長ボタンで猶予タイマーが分数タイマーに付け替わる', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  const countdownTimer = h.controller.states.get(GUILD).timer;

  const interaction = makeButtonInteraction(`autostop:extend:${SESSION_ID}:15`);
  await h.controller.handleButton(interaction);

  const state = h.controller.states.get(GUILD);
  assert.equal(state.phase, 'extended');
  assert.equal(h.timers.pending.has(countdownTimer), false); // 元の60秒は解除
  assert.equal(h.timers.pending.get(state.timer).ms, 15 * 60_000);
  assert.match(interaction.calls.updates[0].content, /15分延長/);
  assert.equal(h.stops.length, 0);
});

test('延長満了後もまだ無人なら新しいプロンプトを再送し、その猶予満了で停止する', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  await h.controller.handleButton(makeButtonInteraction(`autostop:extend:${SESSION_ID}:5`));

  await h.fireTimer(); // 延長満了: まだ無人
  assert.equal(h.sent.length, 2); // プロンプト再送
  assert.equal(h.stops.length, 0);

  await h.fireTimer(); // 再送分の猶予満了
  assert.deepEqual(h.stops, [{ guildId: GUILD, reason: 'auto' }]);
});

test('満了コールバックが既にキュー済みでも延長ボタンが優先される(延長レース)', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  const state = h.controller.states.get(GUILD);
  // 満了コールバックが実行キューに積まれた直後(clearTimeout が効かない)を再現するため、
  // 延長前にコールバックを取り出しておき、延長後に実行する
  const queued = h.timers.pending.get(state.timer);

  await h.controller.handleButton(makeButtonInteraction(`autostop:extend:${SESSION_ID}:5`));
  await queued.fn();

  assert.equal(h.stops.length, 0); // 延長したのに停止しない
  const after = h.controller.states.get(GUILD);
  assert.equal(after.phase, 'extended');
  assert.ok(h.timers.pending.has(after.timer)); // 延長タイマーは孤児にならず生きている
});

test('猶予満了時に guild が取得できなければ停止しない(停止抑制側に倒す)', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  h.controller.getGuild = () => undefined;
  await h.leave('u1');
  await h.fireTimer();

  assert.equal(h.stops.length, 0);
  assert.equal(h.controller.states.size, 0);
});

test('延長満了時に guild が取得できなければ再送も停止もしない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  await h.controller.handleButton(makeButtonInteraction(`autostop:extend:${SESSION_ID}:5`));
  h.controller.getGuild = () => undefined;
  await h.fireTimer();

  assert.equal(h.sent.length, 1); // プロンプト再送なし
  assert.equal(h.stops.length, 0);
  assert.equal(h.controller.states.size, 0);
});

test('延長中に再入室するとキャンセルされ、以降何も起きない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  await h.controller.handleButton(makeButtonInteraction(`autostop:extend:${SESSION_ID}:5`));
  await h.join('u1');

  assert.equal(h.controller.states.size, 0);
  assert.equal(h.timers.pending.size, 0);
  assert.equal(h.stops.length, 0);
});

test('猶予満了時に無人でなくなっていたら停止しない(入室イベント取りこぼしへの保険)', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  // 入室イベントを流さず voiceStates だけ在室に戻す(=イベント取りこぼし想定)
  h.voiceEntries.push({ channelId: VC, id: 'u2', member: { user: { bot: false } } });
  await h.fireTimer();

  assert.equal(h.stops.length, 0);
  assert.equal(h.controller.states.size, 0);
  assert.match(h.sent[0].edits[0].content, /戻ったため/);
});

test('別セッションの古いボタンは ephemeral 応答だけ返し停止しない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');

  const interaction = makeButtonInteraction('autostop:stop:sess-old');
  await h.controller.handleButton(interaction);

  assert.equal(h.stops.length, 0);
  assert.equal(interaction.calls.replies.length, 1);
  assert.match(interaction.calls.replies[0].content, /すでに終了/);
  assert.deepEqual(interaction.calls.messageEdits[0], { components: [] }); // 古いボタンは剥がす
  assert.equal(h.controller.states.size, 1); // 進行中の確認は生きたまま
});

test('プリセットにない延長分数は拒否する', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');

  const interaction = makeButtonInteraction(`autostop:extend:${SESSION_ID}:999`);
  await h.controller.handleButton(interaction);

  assert.match(interaction.calls.replies[0].content, /不正/);
  assert.equal(h.controller.states.get(GUILD).phase, 'countdown'); // タイマーは元のまま
});

test('プロンプト投稿に失敗しても自動停止は生きる', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  h.controller.fetchChannel = async () => {
    throw new Error('channel fetch failed');
  };
  await h.leave('u1');
  assert.equal(h.sent.length, 0);
  await h.fireTimer();
  assert.deepEqual(h.stops, [{ guildId: GUILD, reason: 'auto' }]);
});

test('外部から録音が停止されたら確認状態を片付ける(notifySessionEnded)', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  const state = h.controller.states.get(GUILD);

  h.sessionsMap.delete(GUILD); // /rec stop 相当
  await h.controller.notifySessionEnded(GUILD);

  assert.equal(h.controller.states.size, 0);
  assert.equal(h.timers.pending.has(state.timer), false);
  assert.match(h.sent[0].edits[0].content, /終了しました/);

  // 片付け後にタイマーが発火しても(clearTimeout されない実装だったとしても)停止しない
  assert.equal(h.stops.length, 0);
});

test('セッション消滅後にタイマーが発火しても何もしない', async () => {
  const h = makeHarness({ vcMembers: [{ id: 'u1' }] });
  await h.leave('u1');
  const state = h.controller.states.get(GUILD);
  h.sessionsMap.delete(GUILD); // notifySessionEnded を経ずに消えた想定

  await h.timers.fire(state.timer);
  assert.equal(h.stops.length, 0);
  assert.equal(h.controller.states.size, 0);
});

test('buildPromptComponents は sessionId を customId に埋める', () => {
  const rows = buildPromptComponents('abc');
  const ids = rows[0].components.map((c) => c.custom_id);
  assert.deepEqual(ids, ['autostop:stop:abc', ...EXTEND_MINUTES.map((m) => `autostop:extend:abc:${m}`)]);
});

test('parseEmptyDelayMs: 既定60秒・0で無効・不正値は既定に戻す', () => {
  assert.equal(parseEmptyDelayMs(undefined), DEFAULT_EMPTY_DELAY_MS);
  assert.equal(parseEmptyDelayMs(''), DEFAULT_EMPTY_DELAY_MS);
  assert.equal(parseEmptyDelayMs('90'), 90_000);
  assert.equal(parseEmptyDelayMs('0'), 0);
  assert.equal(parseEmptyDelayMs('abc'), DEFAULT_EMPTY_DELAY_MS);
  assert.equal(parseEmptyDelayMs('-5'), DEFAULT_EMPTY_DELAY_MS);
});
