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
      await channel.send(
        `🎙 ${name} さんがVCに参加しました。\n` +
          `会話を記録する場合は、このVCで \`/rec start\` を実行して録音を開始してください。`,
      );
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
