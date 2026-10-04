import type { AudioRequest, IngestMeta, SessionPayload } from './types.ts';
import type { RESTPostOAuth2AccessTokenResult, RESTGetAPIUserResult, RESTGetAPICurrentUserGuildsResult, RESTGetCurrentUserGuildMemberResult } from 'discord-api-types/v10';

interface LegacyPayloads {
  meta: IngestMeta;
  audio: AudioRequest | null;
  session: SessionPayload;
  config: { guildId: string; requiredRoleId: string };
  token: RESTPostOAuth2AccessTokenResult;
  user: RESTGetAPIUserResult;
  guilds: RESTGetAPICurrentUserGuildsResult;
  member: RESTGetCurrentUserGuildMemberResult;
}

/**
 * 未検証の既存JSON契約を型付けする唯一の assertion 境界。
 * これはvalidationではない。呼び出し側の既存チェックだけを維持し、
 * 追加の拒否条件（HTTPコードや受理範囲の変更）は型移行に混ぜない。
 * Discordは公式REST型、recorderは従来のwire形式、cookieは署名済payload。
 */
export function legacyPayload<K extends keyof LegacyPayloads>(kind: K, value: unknown): LegacyPayloads[K] {
  void kind;
  return value as LegacyPayloads[K];
}

// Error 以外に {message: ...} がthrowされる場合も従来の判定を残す。
export function errorMessage(error: unknown): unknown {
  return error != null && (typeof error === 'object' || typeof error === 'function') && 'message' in error
    ? error.message : undefined;
}
