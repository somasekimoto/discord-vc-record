/**
 * join-prompt.js — VC参加時の録音開始リマインダー。
 *
 * RECORD_PROMPT_CHANNEL_IDS で指定した VC に人が入ったとき、
 * その VC のテキストチャット(Text in Voice)へ /rec start を促すメッセージを投稿する。
 *
 * スパム防止のため以下の場合は投稿しない:
 *  - Bot 自身の入退室
 *  - そのギルドで録音セッションが進行中
 *  - VC に既に他の人がいる(最初の入室者にだけ通知)
 *  - 同一チャンネルでクールダウン時間内に通知済み
 */

export const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

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
    /** @type {Map<string, number>} channelId -> 最終通知時刻 */
    this.lastPromptedAt = new Map();
  }

  /**
   * voiceStateUpdate から呼ぶ。通知すべきなら VC チャットへ投稿する。
   * @returns {Promise<boolean>} 投稿した(しようとした)かどうか
   */
  async handleVoiceState(oldState, newState) {
    const channelId = newState.channelId;
    if (!channelId || !this.channelIds.has(channelId)) return false;
    if (oldState.channelId === channelId) return false; // 同一VC内の状態変化(ミュート等)
    if (newState.member?.user?.bot) return false;

    const guildId = newState.guild?.id;
    if (guildId && this.sessions?.get(guildId)) return false; // 既に録音中

    const channel = newState.channel;
    if (!channel) return false;

    // 既に他の人がいるなら通知済みのはず(最初の入室者にだけ知らせる)
    const humans = channel.members?.filter?.((m) => !m.user?.bot);
    if (humans && humans.size > 1) return false;

    const last = this.lastPromptedAt.get(channelId);
    const now = this.now();
    if (last != null && now - last < this.cooldownMs) return false;
    this.lastPromptedAt.set(channelId, now);

    const name = newState.member?.displayName ?? 'メンバー';
    try {
      await channel.send(
        `🎙 ${name} さんがVCに参加しました。\n` +
          `会話を記録する場合は、このVCで \`/rec start\` を実行して録音を開始してください。`,
      );
    } catch (err) {
      console.error(`[join-prompt] failed to send prompt to channel ${channelId}: ${err.message}`);
    }
    return true;
  }
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
