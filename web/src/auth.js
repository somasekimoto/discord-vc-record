/**
 * auth.js — Discord OAuth2 ログインとセッションcookie
 *
 * フロー:
 *   /login            -> Discord 認可画面へリダイレクト(scope: identify guilds.members.read)
 *   /callback         -> code をトークン交換 -> ユーザーID取得 -> 署名cookie発行
 *   getSession(req)   -> cookie を検証して { userId, accessToken } を返す
 *
 * cookie は HMAC 署名付きの自己完結トークン(KV不要)。
 */
const OAUTH_SCOPE = 'identify guilds guilds.members.read';
const COOKIE_NAME = 'vcr_session';
const SESSION_TTL_SEC = 60 * 60 * 8; // 8時間

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(str);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(sig);
}

/** payload(object) を署名付きトークンにする。 */
export async function signSession(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

/** トークンを検証して payload を返す。失敗時 null。 */
export async function verifySession(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = await hmac(secret, body);
  // 時間一定比較
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** リクエストから現在のログインセッションを取り出す。 */
export async function getSession(req, env) {
  const token = getCookie(req, COOKIE_NAME);
  return verifySession(token, env.SESSION_SECRET);
}

/** /login: Discord 認可画面へ。`next` に戻り先を載せる。 */
export function handleLogin(req, env) {
  const url = new URL(req.url);
  const next = url.searchParams.get('next') || '/';
  const redirectUri = `${env.WEB_BASE_URL}/callback`;
  const authUrl = new URL('https://discord.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', OAUTH_SCOPE);
  authUrl.searchParams.set('state', next); // MVP: state に戻り先(本番は CSRF トークン推奨)
  return Response.redirect(authUrl.toString(), 302);
}

/** /callback: code をトークン交換し、cookie を発行して next へ戻す。 */
export async function handleCallback(req, env) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('state') || '/';
  if (!code) return new Response('missing code', { status: 400 });

  const redirectUri = `${env.WEB_BASE_URL}/callback`;
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    return new Response(`token exchange failed: ${await tokenRes.text()}`, { status: 502 });
  }
  const tok = await tokenRes.json();

  // ユーザーID取得
  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!meRes.ok) return new Response('failed to fetch user', { status: 502 });
  const me = await meRes.json();

  const payload = {
    userId: me.id,
    username: me.username,
    accessToken: tok.access_token,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const token = await signSession(payload, env.SESSION_SECRET);

  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`,
  );
  headers.set('Location', next);
  return new Response(null, { status: 302, headers });
}

export function handleLogout() {
  const headers = new Headers();
  headers.append('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  headers.set('Location', '/');
  return new Response(null, { status: 302, headers });
}
