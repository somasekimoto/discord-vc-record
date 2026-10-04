// ローカル回帰テスト専用エントリ。dev/deploy scripts からは参照しない。
import worker from '../src/index.ts';
import { canAccessGuild } from '../src/authz.ts';
import { signSession, verifySession, getSession } from '../src/auth.ts';

type TestEnv = Env & { TEST_RUN_ID: string };

let discordMode = 'success';
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;

let discordCalls = 0;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith('https://discord.com/')) throw new Error('unexpected external request');
  discordCalls++;
  if (String(input).endsWith('/oauth2/token')) {
    const body = init?.body;
    if (init?.method !== 'POST' || !(body instanceof URLSearchParams)
        || body.get('client_id') !== '123' || body.get('client_secret') !== 'dummy'
        || body.get('grant_type') !== 'authorization_code' || !body.get('code')
        || body.get('redirect_uri') !== 'http://127.0.0.1:8788/callback') {
      throw new Error('unexpected OAuth token request');
    }
    return discordMode === 'token-error' ? new Response('no', { status: 401 }) : Response.json({ access_token: 'dummy-token' });
  }
  if (String(input).endsWith('/users/@me')) return discordMode === 'user-error' ? new Response('no', { status: 401 }) : Response.json({ id: '1', username: 'テスト' });
  const auth = new Headers(init?.headers).get('Authorization') || '';
  const status = Number(auth.replace('Bearer status-', ''));
  if (status >= 400) return new Response('mock discord error', { status });
  if (String(input).endsWith('/guilds')) return Response.json([{ id: '9001', name: '<Guild>' }]);
  return Response.json({ roles: auth === 'Bearer allowed' ? ['7001'] : [] });
};

export default {
  async fetch(req: Request, env: TestEnv) {
    const url = new URL(req.url);
    if (url.pathname === '/__test/identity') return Response.json({ runId: env.TEST_RUN_ID });
    if (url.pathname === '/__test/clock') { clockOffset = Number(url.searchParams.get('offset') || 0); return new Response('ok'); }
    if (url.pathname === '/__test/remove-files') {
      await env.BUCKET.delete('sessions/9002/nullable-fixture/transcript.md');
      return new Response('ok');
    }
    if (url.pathname === '/__test/tracks') {
      const { results } = await env.DB.prepare('SELECT user_id, r2_key, duration_sec FROM tracks WHERE session_id = ? ORDER BY user_id').bind('route-fixture').all<{ user_id: string; r2_key: string | null; duration_sec: number | null }>();
      return Response.json({ tracks: results });
    }
    if (url.pathname === '/__test/mode') { discordMode = url.searchParams.get('mode') || 'success'; return new Response('ok'); }
    if (url.pathname === '/__test/sign') {
      const token = await signSession({ userId: '1', username: 'テスト', accessToken: 'dummy-token', exp: Number(url.searchParams.get('exp') ?? 4000000000) }, env.SESSION_SECRET);
      return new Response(token);
    }
    if (url.pathname === '/__test/verify') {
      return Response.json(await verifySession(url.searchParams.get('token'), url.searchParams.get('secret') || env.SESSION_SECRET));
    }
    if (url.pathname === '/__test/session') return Response.json(await getSession(req, env));
    if (url.pathname === '/__test/seed') {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS guild_config (guild_id TEXT PRIMARY KEY, required_role_id TEXT, updated_at INTEGER)");
      await env.DB.prepare('INSERT OR REPLACE INTO guild_config VALUES (?, ?, 0)').bind(url.searchParams.get('guild') || '9001', url.searchParams.get('role') || null).run();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__test/authz') {
      const accessToken = url.searchParams.get('token') || 'allowed';
      const userId = url.searchParams.get('user') || '1';
      const session = url.searchParams.has('anonymous') ? null : { userId, username: 'test', accessToken, exp: 4000000000 };
      const result = await canAccessGuild(session, url.searchParams.get('guild') || '9001', env);
      return Response.json({ ...result, discordCalls });
    }
    if (url.pathname === '/__test/cookie') {
      const token = await signSession({ userId: 'route-user', username: '<User>', accessToken: 'allowed', exp: 4000000000 }, env.SESSION_SECRET);
      return new Response(`vcr_session=${token}`);
    }
    return worker.fetch(req, env);
  },
} satisfies ExportedHandler<TestEnv>;
