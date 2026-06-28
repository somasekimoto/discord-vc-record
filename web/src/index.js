/**
 * index.js — WebUI + 認証 + 配信(Cloudflare Worker)
 *
 * ルート:
 *   GET  /                      ギルド一覧の案内(ログイン誘導)
 *   GET  /login, /callback, /logout   Discord OAuth2
 *   GET  /g/:guildId            そのギルドのセッション一覧(要ロール)
 *   GET  /s/:sessionId          セッション詳細 + 文字起こし表示(要ロール)
 *   GET  /s/:sessionId/dl/:kind 文字起こし/音声のダウンロード(要ロール)
 *   POST /ingest                recorder からの取り込み(INGEST_SECRET)
 *
 * 認可は毎リクエスト Discord に問い合わせてロール保有を確認する。
 */
import { getSession, handleLogin, handleCallback, handleLogout } from './auth.js';
import { canAccessGuild } from './authz.js';
import { handleIngest } from './ingest.js';
import { listGuildsWithSessions, listChannels, listSessions, getSession as getSessionRow, getParticipants, getTracks, setRequiredRole } from './db.js';

const html = (body, title = 'VC Record') =>
  new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${title}</title>` +
      `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.7;color:#1a1a1a}` +
      `a{color:#5865F2}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem}` +
      `.card{border:1px solid #e3e3e3;border-radius:10px;padding:.8rem 1rem;margin:.6rem 0}` +
      `.muted{color:#888;font-size:.85rem}.btn{display:inline-block;background:#5865F2;color:#fff;padding:.4rem .9rem;border-radius:8px;text-decoration:none;font-size:.9rem}` +
      `pre{white-space:pre-wrap;background:#f6f6f7;padding:1rem;border-radius:8px}</style></head><body>${body}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '-');

function denyMessage(reason, guildId) {
  const map = {
    not_logged_in: ['ログインが必要です', `<a class="btn" href="/login?next=${encodeURIComponent(`/g/${guildId}`)}">Discordでログイン</a>`],
    no_role_configured: ['このサーバーは閲覧ロールが未設定です。管理者が <code>/setup</code> で設定してください。', ''],
    not_a_member: ['このDiscordサーバーのメンバーではありません。', ''],
    missing_role: ['閲覧に必要なロールを持っていません。', ''],
    rate_limited: ['Discordへの問い合わせが混み合っています。数秒待ってから再読み込みしてください。', `<a class="btn" href="/g/${guildId}">再読み込み</a>`],
    token_expired: ['セッションの有効期限が切れました。', `<a class="btn" href="/login?next=${encodeURIComponent(`/g/${guildId}`)}">再ログイン</a>`],
  };
  const [msg, action] = map[reason] || [`アクセスできません。(${esc(reason || 'unknown')})`, ''];
  return html(`<h1>閲覧できません</h1><p>${msg}</p>${action}`);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // --- 認証なしルート ---
      if (path === '/login') return handleLogin(req, env);
      if (path === '/callback') return handleCallback(req, env);
      if (path === '/logout') return handleLogout();
      if (path === '/ingest' && req.method === 'POST') return handleIngest(req, env);

      // recorder の /setup から呼ばれる: ギルドの閲覧ロールを保存(INGEST_SECRET 認証)
      if (path === '/config' && req.method === 'POST') {
        const auth = req.headers.get('Authorization') || '';
        if (!env.INGEST_SECRET || auth !== `Bearer ${env.INGEST_SECRET}`) {
          return new Response('unauthorized', { status: 401 });
        }
        const { guildId, requiredRoleId } = await req.json();
        if (!guildId || !requiredRoleId) return new Response('missing fields', { status: 400 });
        await setRequiredRole(env.DB, guildId, requiredRoleId);
        return Response.json({ ok: true });
      }

      if (path === '/') {
        const session = await getSession(req, env);
        if (!session) {
          return html(
            `<h1>Discord VC 文字起こし</h1>` +
              `<p>録音された会話を、対象ロールを持つメンバーが閲覧できます。</p>` +
              `<p><a class="btn" href="/login">Discordでログイン</a></p>`,
          );
        }

        // ユーザーの所属ギルドを取得し、「録音があり」「アクセスできる」ものだけ出す
        const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        const myGuilds = guildsRes.ok ? await guildsRes.json() : [];
        const nameById = new Map(myGuilds.map((g) => [g.id, g.name]));

        const recorded = await listGuildsWithSessions(env.DB);
        const visible = [];
        for (const g of recorded) {
          if (!nameById.has(g.guild_id)) continue; // 所属していないギルドは出さない
          const access = await canAccessGuild(session, g.guild_id, env);
          if (access.allowed) {
            visible.push({ ...g, name: nameById.get(g.guild_id) });
          }
        }

        const who = `ログイン中: <b>${esc(session.username)}</b> · <a href="/logout">ログアウト</a>`;
        const list = visible.length
          ? visible.map((g) =>
              `<div class="card"><a href="/g/${esc(g.guild_id)}">🏠 ${esc(g.name)}</a>` +
                `<div class="muted">${g.session_count}件 · 最新 ${fmtDate(g.last_at)}</div></div>`,
            ).join('')
          : `<p class="muted">閲覧できる録音のあるサーバーがありません。<br>` +
            `（録音がない、対象ロールを持っていない、または管理者が <code>/setup</code> でロール未設定の可能性）</p>`;
        return html(
          `<h1>Discord VC 文字起こし</h1><p>${who}</p>` +
            `<h2>閲覧できるサーバー</h2>${list}`,
        );
      }

      // --- 認可が要るルート ---
      const session = await getSession(req, env);

      // /g/:guildId — VC(チャンネル)一覧
      let m = path.match(/^\/g\/(\d+)\/?$/);
      if (m) {
        const guildId = m[1];
        const access = await canAccessGuild(session, guildId, env);
        if (!access.allowed) return denyMessage(access.reason, guildId);

        const channels = await listChannels(env.DB, guildId);
        const items = channels.length
          ? channels.map((c) =>
              `<div class="card"><a href="/g/${esc(guildId)}/c/${esc(c.channel_id)}">🔊 ${esc(c.channel_name || c.channel_id)}</a>` +
                `<div class="muted">${c.session_count}件 · 最新 ${fmtDate(c.last_at)}</div></div>`,
            ).join('')
          : '<p class="muted">まだ録音がありません。</p>';
        return html(`<h1>ボイスチャンネル一覧</h1><p class="muted">サーバー ${esc(guildId)}</p>${items}`);
      }

      // /g/:guildId/c/:channelId — そのVCの録音一覧
      m = path.match(/^\/g\/(\d+)\/c\/(\d+)\/?$/);
      if (m) {
        const [, guildId, channelId] = m;
        const access = await canAccessGuild(session, guildId, env);
        if (!access.allowed) return denyMessage(access.reason, guildId);

        const rows = await listSessions(env.DB, guildId, channelId);
        const chName = rows[0]?.channel_name || channelId;
        const items = rows.length
          ? rows.map((s) =>
              `<div class="card"><a href="/s/${esc(s.id)}">${fmtDate(s.started_at)} の録音</a>` +
                `<div class="muted">${esc(s.status)} · ${esc(s.engine || '')}</div></div>`,
            ).join('')
          : '<p class="muted">このVCの録音はまだありません。</p>';
        return html(
          `<p><a href="/g/${esc(guildId)}">← VC一覧へ</a></p>` +
            `<h1>🔊 ${esc(chName)} の録音</h1>${items}`,
        );
      }

      // /s/:sessionId/dl/:kind — ダウンロード
      m = path.match(/^\/s\/([^/]+)\/dl\/([^/]+)$/);
      if (m) {
        const [, sessionId, kind] = m;
        const row = await getSessionRow(env.DB, sessionId);
        if (!row) return new Response('not found', { status: 404 });
        const access = await canAccessGuild(session, row.guild_id, env);
        if (!access.allowed) return denyMessage(access.reason, row.guild_id);

        let key, filename, ctype;
        if (kind === 'md') {
          key = row.transcript_key; filename = 'transcript.md'; ctype = 'text/markdown; charset=utf-8';
        } else if (kind === 'json') {
          key = row.transcript_json_key; filename = 'transcript.json'; ctype = 'application/json';
        } else if (kind.startsWith('audio-')) {
          const userId = kind.slice('audio-'.length);
          key = `sessions/${row.guild_id}/${sessionId}/audio/${userId}.wav`;
          filename = `${userId}.wav`; ctype = 'audio/wav';
        } else {
          return new Response('bad kind', { status: 400 });
        }
        if (!key) return new Response('not available', { status: 404 });
        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response('not found in storage', { status: 404 });
        return new Response(obj.body, {
          headers: {
            'Content-Type': ctype,
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      // /s/:sessionId — 詳細
      m = path.match(/^\/s\/([^/]+)\/?$/);
      if (m) {
        const sessionId = m[1];
        const row = await getSessionRow(env.DB, sessionId);
        if (!row) return new Response('not found', { status: 404 });
        const access = await canAccessGuild(session, row.guild_id, env);
        if (!access.allowed) return denyMessage(access.reason, row.guild_id);

        const [participants, tracks] = await Promise.all([
          getParticipants(env.DB, sessionId),
          getTracks(env.DB, sessionId),
        ]);

        // 文字起こし本文を R2 から読む
        let transcript = '(文字起こしがありません)';
        if (row.transcript_key) {
          const obj = await env.BUCKET.get(row.transcript_key);
          if (obj) transcript = await obj.text();
        }

        const pList = participants.map((p) => esc(p.display_name || p.user_id)).join('、') || '-';
        const dlAudio = tracks
          .filter((t) => t.r2_key)
          .map((t) => `<a href="/s/${esc(sessionId)}/dl/audio-${esc(t.user_id)}">${esc(t.user_id)}.wav</a>`)
          .join(' / ');

        return html(
          `<p><a href="/g/${esc(row.guild_id)}/c/${esc(row.channel_id)}">← ${esc(row.channel_name || '録音一覧')}へ</a></p>` +
            `<h1>${fmtDate(row.started_at)} の録音</h1>` +
            `<p class="muted">🔊 ${esc(row.channel_name || row.channel_id)} · 参加者: ${pList}</p>` +
            `<p><a class="btn" href="/s/${esc(sessionId)}/dl/md">文字起こしをDL(.md)</a> ` +
            `<a class="btn" href="/s/${esc(sessionId)}/dl/json">JSON</a></p>` +
            (dlAudio ? `<p class="muted">音声: ${dlAudio}</p>` : '') +
            `<h2>文字起こし</h2><pre>${esc(transcript)}</pre>`,
          '録音詳細',
        );
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      return new Response(`error: ${err.message}`, { status: 500 });
    }
  },
};
