/**
 * join-prompt.js — VC参加時の録音開始リマインダー。
 *
 * RECORD_PROMPT_CHANNEL_IDS で指定した VC に人が入ったとき、
 * その VC のテキストチャット(Text in Voice)へ録音開始を促すメッセージを投稿する。
 * メッセージには開始ボタンを付け、/rec start を打たなくても録音を始められる。
 *
 * スパム防止のため以下の場合は投稿しない:
 *  - Bot 自身の入退室
 *  - そのギルドで録音セッションが進行中
 *  - VC に既に他の人がいる(最初の入室者にだけ通知)
 *  - 同一チャンネルでクールダウン時間内に通知済み
 */
import { MessageFlags } from 'discord.js';

export const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** 開始ボタンの customId プレフィックス。index.js の interaction 分岐と対応する。 */
export const START_BUTTON_PREFIX = 'recstart';

/**
 * 開始ボタン行を組む(auto-stop.js と同じく raw component で表現)。
 * customId に対象 VC の channelId を埋め、押下時に「どの VC を録音するか」を
 * ボタン側で一意に決める(押した人が別の VC にいる場合を弾くため)。
 */
export function buildStartComponents(channelId) {
  return [
    {
      type: 1, // ActionRow
      components: [
        {
          type: 2,
          style: 3, // Success
          label: '録音を開始',
          custom_id: `${START_BUTTON_PREFIX}:${channelId}`,
        },
      ],
    },
  ];
}

export class JoinPromptNotifier {
  /**
   * @param {object} opts
   * @param {Set<string>|string[]} opts.channelIds 通知対象の VC ID
   * @param {import('./recorder.js').SessionManager} opts.sessions
   * @param {number} [opts.cooldownMs]
   * @param {() => number} [opts.now] テスト用の時刻取得
   */
  constructor({ channelIds, sessions, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now }) {
    this.channelIds = new Set(channelIds);
    this.sessions = sessions;
    this.cooldownMs = cooldownMs;
    this.now = now;
    /**
     * @type {Map<string, number>} channelId -> 最終通知時刻
     * インメモリ保持。再起動で消えるが、recorder は単一インスタンス運用
     * (fly deploy --ha=false) が前提なのでプロセス間共有は不要。
     */
    this.lastPromptedAt = new Map();
  }

  /**
   * voiceStateUpdate から呼ぶ。通知すべきなら VC チャットへ投稿する。
   * @returns {Promise<boolean>} 投稿できたかどうか
   */
  async handleVoiceState(oldState, newState) {
    const channelId = newState.channelId;
    if (!channelId || !this.channelIds.has(channelId)) return false;
    if (oldState.channelId === channelId) return false; // 同一VC内の状態変化(ミュート等)
    if (newState.member?.user?.bot) return false;

    const guildId = newState.guild?.id;
    if (guildId && this.sessions?.get(guildId)) return false; // 既に録音中

    const channel = newState.channel;
    if (!channel) {
      // Guilds インテントがあれば通常キャッシュされている。ここに来たら設定ミスの可能性
      console.warn(`[join-prompt] channel ${channelId} not in cache; prompt skipped`);
      return false;
    }

    // 既に他の人がいるなら通知済みのはず(最初の入室者にだけ知らせる)。
    // channel.members は member キャッシュ依存で、再起動直後は在室者を取りこぼす
    // (GuildMembers インテント無しでは GUILD_CREATE の voice_states に member が載らない)。
    // そのため voiceStates で数え、member 未解決の在室者は人間扱いする(誤通知より抑制に倒す)。
    const voiceStates = newState.guild?.voiceStates?.cache;
    if (voiceStates) {
      const others = voiceStates.filter(
        (vs) => vs.channelId === channelId && vs.id !== newState.id && vs.member?.user?.bot !== true,
      );
      if (others.size > 0) return false;
    }

    const last = this.lastPromptedAt.get(channelId);
    const now = this.now();
    if (last != null && now - last < this.cooldownMs) return false;
    // send の await 前に記録することで、同時入室での二重投稿を防ぐ
    this.lastPromptedAt.set(channelId, now);

    const name = newState.member?.displayName ?? 'メンバー';
    try {
      await channel.send({
        content:
          `🎙 ${name} さんがVCに参加しました。\n` +
          `会話を記録する場合は、下のボタン（または \`/rec start\`）で録音を開始してください。`,
        components: buildStartComponents(channelId),
      });
    } catch (err) {
      // 一時的な失敗で5分間沈黙しないよう、クールダウンを戻して次の入室で再試行させる
      this.lastPromptedAt.delete(channelId);
      console.error(`[join-prompt] failed to send prompt to channel ${channelId}: ${err.message}`);
      return false;
    }
    return true;
  }
}

/**
 * 開始ボタン(`recstart:<channelId>`)の押下を処理する。
 *
 * 押下時点の状態から判定するので、Bot 再起動やクールダウンをまたいで残った
 * 古いボタンが押されても安全に扱える。どの分岐でも必ず何か応答し、
 * 「インタラクション失敗」表示を出さない。
 *
 * @param {object} interaction ボタン interaction
 * @param {object} deps
 * @param {{get:(guildId:string)=>object|undefined}} deps.sessions SessionManager
 * @param {(opts:object)=>Promise<object>} deps.startSession 録音開始(コマンド経路と共通)
 * @param {() => Promise<{warning:string|null}>} [deps.checkDisk] 空き容量の警告(任意)
 */
export async function handleStartButton(interaction, { sessions, startSession, checkDisk }) {
  const channelId = interaction.customId.split(':')[1];
  const guildId = interaction.guildId;

  const reply = (content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});

  // 既に録音中(別の人が先に開始した / /rec start 済み)。二重開始しない。
  if (sessions.get(guildId)) {
    await reply('このサーバーでは既に録音中です。');
    await interaction.message?.edit({ components: [] }).catch(() => {});
    return false;
  }

  const voiceChannelId = interaction.member?.voice?.channelId;
  if (!voiceChannelId) {
    await reply('先にVCに参加してから録音を開始してください。');
    return false;
  }
  // ボタンの VC と押した人の VC が食い違う場合は拒否する。
  // 本人のいる VC を勝手に録音すると、押した本人の意図と食い違いうるため。
  if (voiceChannelId !== channelId) {
    await reply('このボタンは別のVC用です。参加中のVCで `/rec start` を実行してください。');
    return false;
  }

  // 開始確定を先に宣言し、同時押下での二重開始を防ぐ。実際の排他は
  // SessionManager.start が byGuild への登録で担保する(後着は throw)。
  await interaction.deferUpdate().catch(() => {});
  let session;
  try {
    session = await startSession({
      guildId,
      channelId,
      startedByUserId: interaction.user.id,
      // 自動停止などの通知先はボタンが置かれたチャンネル(Text in Voice)
      notifyChannelId: interaction.channelId,
    });
  } catch (err) {
    console.error(`[join-prompt] start button failed (guild=${guildId}): ${err.message}`);
    await reply(`録音を開始できませんでした: ${err.message}`);
    return false;
  }

  const warning = checkDisk ? (await checkDisk().catch(() => ({}))).warning : null;
  await interaction.message
    ?.edit({
      content:
        `🔴 録音を開始しました（セッション: \`${session.id}\`）\n` +
        `このVCの会話を話者ごとに記録します。終了するには \`/rec stop\` を実行してください。` +
        (warning ? `\n\n${warning}` : ''),
      components: [],
    })
    .catch(() => {});
  return true;
}

/**
 * 環境変数(カンマ区切り)を VC ID の配列にパースする。
 * @param {string|undefined} raw
 * @returns {string[]}
 */
export function parsePromptChannelIds(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
