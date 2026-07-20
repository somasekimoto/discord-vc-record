/**
 * auto-stop.js — VC 無人時の録音自動停止。
 *
 * 録音中の VC から人間の参加者が全員いなくなったら、/rec start が打たれた
 * テキストチャンネルへボタン付きメッセージを投稿し、猶予時間(既定60秒)の
 * 経過で録音を自動停止する。ボタンで即時終了 / 分数指定の延長ができる。
 *
 * 状態遷移:
 *  - 無人検知 → countdown: プロンプト投稿 + 猶予タイマー
 *      - 誰かが VC に戻る → キャンセル(メッセージ編集)
 *      - 「すぐ終了」ボタン → 即停止
 *      - 「+N分」ボタン → extended: N分タイマーへ付け替え
 *      - 猶予満了 → 自動停止
 *  - extended: N分後にまだ無人なら新しいプロンプトを再送して countdown へ戻る
 *      (何度でも延長できるが、放置された録音は最終的に必ず止まる)
 *
 * 無人判定は join-prompt.js と同じく voiceStates ベースの best-effort。
 * member 未解決の在室者は人間扱いし、会議中の誤停止より停止抑制に倒す。
 * タイマーはインメモリ保持(recorder は単一インスタンス運用が前提)。
 */
import { MessageFlags } from 'discord.js';

export const DEFAULT_EMPTY_DELAY_MS = 60_000;

/** 延長ボタンの分数プリセット。customId 検証にも使う。 */
export const EXTEND_MINUTES = [5, 15, 30];

/**
 * プロンプトのボタン行を組む(discord.js builder を使わず raw component で表現)。
 * sessionId を customId に埋め、停止済みセッションの古いボタンを弾けるようにする。
 */
export function buildPromptComponents(sessionId) {
  return [
    {
      type: 1, // ActionRow
      components: [
        { type: 2, style: 4, label: 'すぐ終了', custom_id: `autostop:stop:${sessionId}` },
        ...EXTEND_MINUTES.map((m) => ({
          type: 2,
          style: 2,
          label: `+${m}分`,
          custom_id: `autostop:extend:${sessionId}:${m}`,
        })),
      ],
    },
  ];
}

/**
 * AUTO_STOP_EMPTY_SEC(秒) をミリ秒にパースする。
 * 未設定・不正値は既定(60秒)、0 は機能無効を意味する。
 */
export function parseEmptyDelayMs(raw) {
  if (raw == null || raw === '') return DEFAULT_EMPTY_DELAY_MS;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec < 0) return DEFAULT_EMPTY_DELAY_MS;
  return sec * 1000;
}

export class AutoStopController {
  /**
   * @param {object} opts
   * @param {{get:(guildId:string)=>object|undefined}} opts.sessions SessionManager
   * @param {(guildId:string, reason:string)=>Promise<void>} opts.stop 停止処理(冪等であること)
   * @param {(channelId:string)=>Promise<{send:Function}>} opts.fetchChannel 通知チャンネル取得
   * @param {(guildId:string)=>object|undefined} opts.getGuild タイマー発火時の無人再確認用
   * @param {number} [opts.emptyDelayMs] 無人からの自動停止猶予
   * @param {{setTimeout:Function, clearTimeout:Function}} [opts.timers] テスト用タイマー注入
   */
  constructor({ sessions, stop, fetchChannel, getGuild, emptyDelayMs = DEFAULT_EMPTY_DELAY_MS, timers }) {
    this.sessions = sessions;
    this.stop = stop;
    this.fetchChannel = fetchChannel;
    this.getGuild = getGuild;
    this.emptyDelayMs = emptyDelayMs;
    this.timers = timers ?? { setTimeout: (...a) => setTimeout(...a), clearTimeout: (id) => clearTimeout(id) };
    /**
     * @type {Map<string, {sessionId:string, phase:'countdown'|'extended', timer:any, message:object|null}>}
     * guildId -> 進行中の無人確認状態
     */
    this.states = new Map();
  }

  /** voiceStateUpdate から呼ぶ。録音対象 VC の退出/入室だけに反応する。 */
  async handleVoiceState(oldState, newState) {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const session = this.sessions.get(guildId);
    if (!session) return;

    // Bot(自分自身を含む)の入退室は無人判定に影響しない
    const member = newState.member ?? oldState.member;
    if (member?.user?.bot) return;

    const joined = newState.channelId === session.channelId && oldState.channelId !== session.channelId;
    const left = oldState.channelId === session.channelId && newState.channelId !== session.channelId;

    if (joined) {
      await this._cancel(guildId, '▶ メンバーが VC に戻ったため、録音を継続します。');
      return;
    }
    if (!left) return;

    const guild = newState.guild ?? oldState.guild;
    if (!this._isVcEmpty(guild, session.channelId)) return;
    if (this.states.has(guildId)) return; // 既に確認中(多重投稿防止)
    await this._startCountdown(guildId, session);
  }

  /** customId が `autostop:` で始まるボタン interaction を処理する。 */
  async handleButton(interaction) {
    const [, action, sessionId, minutesRaw] = interaction.customId.split(':');
    const guildId = interaction.guildId;
    const session = this.sessions.get(guildId);
    const state = this.states.get(guildId);

    // セッションが既に終了している / 別セッションの古いボタン
    if (!session || session.id !== sessionId || !state || state.sessionId !== sessionId) {
      await interaction
        .reply({ content: 'この録音はすでに終了しています。', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      await interaction.message?.edit({ components: [] }).catch(() => {});
      return;
    }

    if (action === 'stop') {
      // 停止確定を先に済ませ、タイマー発火や二重押下と競合させない
      this.states.delete(guildId);
      this.timers.clearTimeout(state.timer);
      await interaction
        .update({ content: '⏹ ボタン操作により録音を終了します。', components: [] })
        .catch(() => {});
      await this.stop(guildId, 'button');
      return;
    }

    if (action === 'extend') {
      const minutes = Number(minutesRaw);
      if (!EXTEND_MINUTES.includes(minutes)) {
        await interaction
          .reply({ content: '不正な延長時間です。', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return;
      }
      this.timers.clearTimeout(state.timer);
      state.phase = 'extended';
      state.timer = this.timers.setTimeout(
        () =>
          this._onExtensionExpired(guildId, state).catch((err) => {
            console.error(`[auto-stop] extension timer error (guild=${guildId}): ${err.message}`);
          }),
        minutes * 60_000,
      );
      state.timer.unref?.();
      await interaction
        .update({
          content:
            `⏸ 自動終了を${minutes}分延長しました。録音は継続中です。\n` +
            `無人のまま${minutes}分経過すると、再度このチャンネルで確認します。`,
          components: [],
        })
        .catch(() => {});
    }
  }

  /** /rec stop 等でセッションが外部から終了したとき、残っている確認状態を片付ける。 */
  async notifySessionEnded(guildId) {
    await this._cancel(guildId, '⏹ 録音は終了しました。');
  }

  /**
   * VC に人間が残っていないか。
   * member 未解決(キャッシュ漏れ)の在室者は人間扱い = 「無人ではない」と判定する。
   * voiceStates が取れない場合も停止しない側に倒す。
   */
  _isVcEmpty(guild, channelId) {
    const cache = guild?.voiceStates?.cache;
    if (!cache) return false;
    const humans = cache.filter((vs) => vs.channelId === channelId && vs.member?.user?.bot !== true);
    return humans.size === 0;
  }

  async _startCountdown(guildId, session) {
    const state = { sessionId: session.id, phase: 'countdown', timer: null, message: null };
    // send の await 前に登録し、退出イベント連発での多重カウントダウンを防ぐ
    this.states.set(guildId, state);
    // タイマーを先に張る: プロンプト投稿に失敗しても自動停止(無人録音の垂れ流し防止)は生かす
    state.timer = this.timers.setTimeout(
      () =>
        this._onCountdownExpired(guildId, state).catch((err) => {
          console.error(`[auto-stop] countdown timer error (guild=${guildId}): ${err.message}`);
        }),
      this.emptyDelayMs,
    );
    state.timer.unref?.();

    const secs = Math.round(this.emptyDelayMs / 1000);
    try {
      const channel = await this.fetchChannel(session.notifyChannelId);
      state.message = await channel.send({
        content:
          `🕐 VC が無人になりました。このまま **${secs}秒** 経過すると録音を自動終了します。\n` +
          `休憩などで後で再開する場合は延長ボタンを押してください。`,
        components: buildPromptComponents(session.id),
      });
    } catch (err) {
      console.error(`[auto-stop] failed to send prompt (guild=${guildId}): ${err.message}`);
    }
  }

  async _onCountdownExpired(guildId, state) {
    if (this.states.get(guildId) !== state) return; // キャンセル済み
    // 満了直前に延長ボタンが押された場合、このコールバックは既に実行キューに
    // 積まれていて clearTimeout が効かない。state は in-place 更新なので同一性
    // ガードでは判別できず、phase で「延長済み」を弾いて延長タイマーに任せる。
    if (state.phase !== 'countdown') return;
    const session = this.sessions.get(guildId);
    if (!session || session.id !== state.sessionId) {
      this.states.delete(guildId);
      return;
    }
    // 発火時点で無人かを再確認(入室イベント取りこぼしへの保険)。
    // guild が取れず確認できない場合も、誤停止よりは停止抑制側に倒す。
    const guild = this.getGuild(guildId);
    if (!guild || !this._isVcEmpty(guild, session.channelId)) {
      await this._cancel(guildId, '▶ メンバーが VC に戻ったため、録音を継続します。');
      return;
    }
    this.states.delete(guildId);
    await this._editMessage(state, '⏹ VC の無人状態が続いたため、録音を自動終了しました。');
    await this.stop(guildId, 'auto');
  }

  async _onExtensionExpired(guildId, state) {
    if (this.states.get(guildId) !== state) return;
    const session = this.sessions.get(guildId);
    this.states.delete(guildId);
    if (!session || session.id !== state.sessionId) return;
    // まだ無人なら新しいプロンプトを再送してカウントダウンをやり直す(再延長も可能)。
    // 誰か戻っている・guild が取れず無人と確認できない場合は静かに解除(停止抑制側)。
    const guild = this.getGuild(guildId);
    if (!guild || !this._isVcEmpty(guild, session.channelId)) return;
    await this._startCountdown(guildId, session);
  }

  /** 進行中の確認状態を破棄し、プロンプトを編集してボタンを無効化する。 */
  async _cancel(guildId, content) {
    const state = this.states.get(guildId);
    if (!state) return;
    this.states.delete(guildId);
    this.timers.clearTimeout(state.timer);
    await this._editMessage(state, content);
  }

  async _editMessage(state, content) {
    if (!state.message) return;
    try {
      await state.message.edit({ content, components: [] });
    } catch (err) {
      console.error(`[auto-stop] failed to edit prompt: ${err.message}`);
    }
  }
}
