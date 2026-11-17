/*
 * Claude Hub v3 - the whole backend.
 *
 * Static pages come from the assets binding (the public/ folder). Everything under
 * /api and /auth is handled here. Nothing in this file trusts the client: the session
 * cookie is signed, every POST must carry the site's own Origin, and admin rights are
 * checked against ADMIN_GITHUB_IDS on the server every single time.
 */

import { json, errorJson, nowIso } from './util.js';
import { isRepoName } from './validate.js';
import { kvStore } from './store.js';
import { makeGitHub, makeBudget } from './github.js';
import {
  hubPayload, getSettings, getMember, isAdminId, addGame, removeGame, refresh,
  gamesOfMember, MAX_GAMES_PER_MEMBER
} from './hub.js';
import { repoEligible, hasTopic } from './validate.js';
import { topicOf } from './hub.js';
import { readSession, handleLogin, handleCallback, handleLogout } from './auth.js';
import { isAdmin, adminState, handleAdmin } from './admin.js';

const HUB_CSP = [
  "default-src 'self'",
  "img-src 'self' https://avatars.githubusercontent.com data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src https://*.github.io",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

/* A house game in /games/ is same-origin with the Hub, so it runs in an opaque origin:
   no allow-same-origin, which means it cannot read the Hub's cookies or call the API
   as the player. */
const LEGACY_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock';

const PAGE_FOR = { '/': '/index.html', '/join': '/join.html', '/admin': '/admin.html' };

/* ---------- tiny per-IP rate limit, per isolate ---------- */

const hits = new Map();

function rateLimit(ip, bucket, limit, windowMs) {
  const now = Date.now();
  const key = bucket + '|' + ip;
  const row = hits.get(key);
  if (!row || now - row.start > windowMs) {
    hits.set(key, { start: now, n: 1 });
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    }
    return true;
  }
  row.n++;
  return row.n <= limit;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'local';
}

/* ---------- helpers ---------- */

function withSecurity(res, pathname) {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  const ct = h.get('Content-Type') || '';
  if (pathname.startsWith('/games/')) {
    h.set('Content-Security-Policy', LEGACY_CSP);
  } else if (ct.includes('text/html')) {
    h.set('Content-Security-Policy', HUB_CSP);
    h.set('X-Frame-Options', 'DENY');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch (e) {
    return false;
  }
}

async function readBody(request) {
  if (Number(request.headers.get('Content-Length') || '0') > 10000) return null;
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return null;
  try {
    const text = await request.text();
    if (text.length > 10000) return null;
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch (e) {
    return null;
  }
}

function storeOf(env) {
  if (env.HUB_STORE) return env.HUB_STORE;
  if (env.HUB) return kvStore(env.HUB);
  throw new Error('no storage bound');
}

let hubCache = { at: 0, body: null };

/* ---------- the handler ---------- */

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const method = request.method.toUpperCase();
  const ip = clientIp(request);

  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return errorJson(405, 'method not allowed');
  }

  /* auth pages */
  if (path === '/auth/login' || path === '/auth/callback') {
    if (method !== 'GET') return errorJson(405, 'method not allowed');
    if (!rateLimit(ip, 'auth', 20, 60000)) return errorJson(429, 'slow down a moment');
    const store = storeOf(env);
    const res = path === '/auth/login'
      ? await handleLogin(request, env)
      : await handleCallback(request, env, store);
    return withSecurity(res, path);
  }

  if (path === '/auth/logout') {
    if (method !== 'POST') return errorJson(405, 'POST only');
    if (!sameOrigin(request)) return errorJson(403, 'bad origin');
    return handleLogout(request, env);
  }

  /* public data */
  if (path === '/api/hub' && method === 'GET') {
    const store = storeOf(env);
    const session = await readSession(request, env);
    const useCache = env.HUB_NO_CACHE !== '1';
    if (!session && useCache && hubCache.body && Date.now() - hubCache.at < 5000) {
      return json(hubCache.body);
    }
    const payload = await hubPayload(env, store, session);
    if (!session && useCache) hubCache = { at: Date.now(), body: payload };
    return json(payload);
  }

  if (path === '/api/me' && method === 'GET') {
    const session = await readSession(request, env);
    if (!session) return json({ ok: true, me: null });
    const store = storeOf(env);
    const member = await getMember(store, session.id);
    return json({
      ok: true,
      me: {
        id: session.id,
        login: session.login,
        name: member ? member.name : session.login,
        avatar: member ? member.avatar : null,
        admin: isAdminId(env, session.id),
        member: Boolean(member)
      }
    });
  }

  /* the signed-in member's own repos, for the My games page */
  if (path === '/api/my/repos' && method === 'GET') {
    const session = await readSession(request, env);
    if (!session) return errorJson(401, 'sign in first');
    if (!rateLimit(ip, 'repos', 12, 60000)) return errorJson(429, 'slow down a moment');
    const store = storeOf(env);
    const member = await getMember(store, session.id);
    if (!member) return errorJson(403, 'not a member');
    const gh = makeGitHub(env, makeBudget(4));
    let repos;
    try {
      repos = await gh.listRepos(member.login);
    } catch (e) {
      return errorJson(502, 'GitHub did not answer, try again in a minute');
    }
    const mine = await gamesOfMember(store, member.id);
    const onHub = new Set(mine.map((g) => g.repo.toLowerCase()));
    const topic = topicOf(env);
    const list = repos.filter((r) => repoEligible(r, member.id)).map((r) => ({
      repo: r.name,
      description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
      stars: Number(r.stargazers_count) || 0,
      updated: r.pushed_at || null,
      topic: hasTopic(r, topic),
      onHub: onHub.has(r.name.toLowerCase())
    }));
    return json({
      ok: true, repos: list, limit: MAX_GAMES_PER_MEMBER, used: mine.length, topic: topic
    });
  }

  if (path === '/api/admin/state' && method === 'GET') {
    const session = await readSession(request, env);
    if (!session) return errorJson(401, 'sign in first');
    if (!isAdmin(env, session)) return errorJson(403, 'not for you');
    return json(await adminState(env, storeOf(env)));
  }

  /* everything that changes something */
  if (method === 'POST' && (path.startsWith('/api/'))) {
    if (!sameOrigin(request)) return errorJson(403, 'bad origin');
    if (!rateLimit(ip, 'post', 30, 60000)) return errorJson(429, 'slow down a moment');
    const body = await readBody(request);
    if (!body) return errorJson(400, 'send a small JSON body');
    const session = await readSession(request, env);
    if (!session) return errorJson(401, 'sign in first');
    const store = storeOf(env);

    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(env, session)) return errorJson(403, 'not for you');
      hubCache = { at: 0, body: null };
      return handleAdmin(path, body, env, store, session, ctx);
    }

    const member = await getMember(store, session.id);
    if (!member) return errorJson(403, 'not a member');

    if (path === '/api/games/add') {
      if (!isRepoName(body.repo)) return errorJson(400, 'which repo?');
      const settings = await getSettings(store, env);
      const gh = makeGitHub(env, makeBudget(5));
      const res = await addGame(env, store, {
        member: member, repoName: body.repo, gh: gh,
        roundCategory: settings.round && settings.round.category, by: 'member'
      });
      hubCache = { at: 0, body: null };
      return res.ok ? json({ ok: true, game: res.game }) : errorJson(400, res.error);
    }

    if (path === '/api/games/remove') {
      if (!isRepoName(body.repo)) return errorJson(400, 'which repo?');
      const res = await removeGame(store, member.id, body.repo, 'member');
      hubCache = { at: 0, body: null };
      return res.ok ? json({ ok: true }) : errorJson(404, res.error);
    }

    return errorJson(404, 'no such action');
  }

  if (path.startsWith('/api/') || path.startsWith('/auth/')) {
    return errorJson(404, 'no such endpoint');
  }

  /* static files */
  const page = PAGE_FOR[path];
  const assetReq = page
    ? new Request(new URL(page, url.origin).toString(), { method: 'GET', headers: request.headers })
    : request;
  if (!env.ASSETS) return new Response('no assets bound', { status: 500 });
  const res = await env.ASSETS.fetch(assetReq);
  return withSecurity(res, page || path);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      /* never show a stack trace or anything from env */
      console.log('error at ' + nowIso() + ': ' + (e && e.message));
      return errorJson(500, 'something broke on the Hub');
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const summary = await refresh(env, storeOf(env), {});
      console.log('refresh: ' + JSON.stringify(summary));
    } catch (e) {
      console.log('refresh failed: ' + (e && e.message));
    }
  }
};

export { handle, withSecurity, HUB_CSP, LEGACY_CSP };
