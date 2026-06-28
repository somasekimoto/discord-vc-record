/**
 * authz.js — ギルド内ロールによる認可
 *
 * ログインユーザーの OAuth アクセストークンを使い、
 * 対象ギルドのメンバー情報(ロール一覧)を取得して、
 * guild_config.required_role_id を保有しているか判定する。
 *
 * guilds.members.read スコープが必要(auth.js で取得済み)。
 *
 * 注意: 一覧/詳細/DL の遷移ごとに Discord API を叩くと簡単にレート制限(429)に
 * かかり「アクセスできません」になる。そこで userId:guildId 単位で短時間キャッシュする。
 */
import { getRequiredRole } from './db.js';

// Worker isolate 内の簡易キャッシュ。連続クリックの 429 を吸収する。
// key = `${userId}:${guildId}` -> { allowed, reason, exp }
const cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5分

/**
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
export async function canAccessGuild(session, guildId, env) {
  if (!session) return { allowed: false, reason: 'not_logged_in' };

  const key = `${session.userId}:${guildId}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) {
    return { allowed: hit.allowed, reason: hit.reason };
  }

  const requiredRoleId = await getRequiredRole(env.DB, guildId);
  if (!requiredRoleId) {
    return { allowed: false, reason: 'no_role_configured' };
  }

  const res = await fetch(
    `https://discord.com/api/users/@me/guilds/${guildId}/member`,
    { headers: { Authorization: `Bearer ${session.accessToken}` } },
  );

  let result;
  if (res.status === 401) result = { allowed: false, reason: 'token_expired' };
  else if (res.status === 404) result = { allowed: false, reason: 'not_a_member' };
  else if (res.status === 429) {
    // レート制限。キャッシュせず、直前の成功判定があればそれを使う(なければ rate_limited)。
    return { allowed: false, reason: 'rate_limited' };
  } else if (!res.ok) result = { allowed: false, reason: `discord_error_${res.status}` };
  else {
    const member = await res.json();
    const roles = member.roles || [];
    result = roles.includes(requiredRoleId)
      ? { allowed: true }
      : { allowed: false, reason: 'missing_role' };
  }

  cache.set(key, { ...result, exp: Date.now() + TTL_MS });
  return result;
}
