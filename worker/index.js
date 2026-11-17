/*
 * Claude Hub v3 - the whole backend.
 *
 * Static pages come from the assets binding (the public/ folder). Everything under
 * /api and /auth is handled here. Nothing in this file trusts the client: the session
 * cookie is signed, every POST must carry the site's own Origin, and admin rights are
 * checked against ADMIN_GITHUB_IDS on the server every single time.
 */

import { json, errorJson, nowIso } from './util.js';
import {
  isRepoName, repoEligible, hasTopic, coverKey, coverTypeOk, coverVersion,
  isOwnerKey, COVER_MAX_BYTES
} from './validate.js';
import { kvStore } from './store.js';
import { getState, update, gameId as keyFor } from './state.js';
import { PresenceCore, presenceClient } from './presence.js';
import { makeGitHub, makeBudget } from './github.js';
import {
  hubPayload, getSettings, getMember, isAdminId, addGame, removeGame, refresh,
  gamesOfMember, MAX_GAMES_PER_MEMBER, topicOf, setGameMeta, setGameStatus, maySee,
  coverAllowance, putCover, houseGamesWithEdits, addLog, allowance, setLove, reportGame,
  LOVES_PER_HOUR, REPORTS_PER_DAY, PUBLISHED, DRAFT
} from './hub.js';
import { readSession, handleLogin, handleCallback, handleLogout } from './auth.js';
import { isAdmin, adminState, handleAdmin } from './admin.js';

const HUB_CSP = [
  "default-src 'self'",
  /* blob: is the crop preview the publish form draws before anything is uploaded */
  "img-src 'self' https://avatars.githubusercontent.com data: blob:",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src https://*.github.io",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

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

function withSecurity(res) {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  const ct = h.get('Content-Type') || '';
  if (ct.includes('text/html')) {
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
      ? await handleLogin(request, env, store)
      : await handleCallback(request, env, store);
    return withSecurity(res);
  }

  if (path === '/auth/logout') {
    if (method !== 'POST') return errorJson(405, 'POST only');
    if (!sameOrigin(request)) return errorJson(403, 'bad origin');
    return handleLogout(request, env);
  }

  /* public data */
  if (path === '/api/hub' && method === 'GET') {
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    const useCache = env.HUB_NO_CACHE !== '1';
    if (!session && useCache && hubCache.body && Date.now() - hubCache.at < 5000) {
      return json(hubCache.body);
    }
    const payload = await hubPayload(env, store, session);
    if (!session && useCache) hubCache = { at: Date.now(), body: payload };
    return json(payload);
  }

  if (path === '/api/me' && method === 'GET') {
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    if (!session) return json({ ok: true, me: null });
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
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    if (!session) return errorJson(401, 'sign in first');
    if (!rateLimit(ip, 'repos', 12, 60000)) return errorJson(429, 'slow down a moment');
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
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    if (!session) return errorJson(401, 'sign in first');
    if (!isAdmin(env, session)) return errorJson(403, 'not for you');
    return json(await adminState(env, store));
  }

  /*
   * The cover upload is the one POST that is not JSON: raw image bytes, with the type
   * in the Content-Type header. Same session and Origin checks as everything else, and
   * the bytes have to really be the picture they claim to be.
   */
  if (method === 'POST' && path === '/api/games/cover') {
    if (!sameOrigin(request)) return errorJson(403, 'bad origin');
    if (!rateLimit(ip, 'post', 30, 60000)) return errorJson(429, 'slow down a moment');
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    if (!session) return errorJson(401, 'sign in first');
    const member = await getMember(store, session.id);
    const admin = isAdmin(env, session);
    const repo = url.searchParams.get('repo') || '';
    const slug = url.searchParams.get('house') || '';

    if (Number(request.headers.get('Content-Length') || '0') > COVER_MAX_BYTES) {
      return errorJson(413, 'that picture is too big');
    }
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length > COVER_MAX_BYTES) return errorJson(413, 'that picture is too big');
    const type = coverTypeOk(request.headers.get('Content-Type'), buf);
    if (!type) return errorJson(400, 'send a real WebP, JPEG or PNG picture');

    /* a house game: only the Hub owner */
    if (slug) {
      if (!admin) return errorJson(403, 'not for you');
      const house = (await houseGamesWithEdits(env, store))
        .find((g) => g.id === 'house/' + slug);
      if (!house) return errorJson(404, 'no such house game');
      const allow = await coverAllowance(env, store, 'admin');
      if (!allow.ok) return errorJson(429, 'too many pictures in one hour');
      const cover = await putCover(store, 'house', slug, buf, type);
      await update(store, (st) => {
        st.house[slug] = Object.assign({}, st.house[slug] || {}, { cover: cover });
      });
      hubCache = { at: 0, body: null };
      return json({ ok: true, cover: '/img/cover/house/' + slug + '?v=' + cover.v });
    }

    if (!member) return errorJson(403, 'not a member');
    if (!isRepoName(repo)) return errorJson(400, 'which repo?');
    const game = (await getState(store)).games[keyFor(member.id, repo)];
    if (!game) return errorJson(404, 'that game is not yours or not on the Hub');
    const allow = await coverAllowance(env, store, String(member.id));
    if (!allow.ok) return errorJson(429, 'that is a lot of pictures in one hour, try later');
    const cover = await putCover(store, String(member.id), game.repo, buf, type);
    await update(store, (st) => {
      const rec = st.games[keyFor(member.id, game.repo)];
      if (rec) rec.cover = cover;
    });
    hubCache = { at: 0, body: null };
    await addLog(store, { what: 'cover set', who: member.login, detail: game.id });
    return json({
      ok: true,
      cover: '/img/cover/' + member.id + '/' + encodeURIComponent(game.repo) + '?v=' + cover.v,
      left: allow.left
    });
  }

  /*
   * Presence. A beat every 45 seconds from an open tab, and a visit when somebody
   * actually presses Play. Signed-out players count too, by a random per-tab token, so
   * they show up in "3 playing" but never by name. Both go to the Durable Object and
   * never to KV, and both are allowed to fail quietly: a page with no counts is far
   * better than an error page.
   */
  if (method === 'POST' && path.startsWith('/api/presence/')) {
    if (!sameOrigin(request)) return errorJson(403, 'bad origin');
    if (!rateLimit(ip, 'beat', 90, 60000)) return json({ ok: true });
    const body = await readBody(request);
    if (!body) return errorJson(400, 'send a small JSON body');
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    const member = session ? await getMember(store, session.id) : null;

    /* only a published game counts as somewhere to be */
    let game = null;
    const asked = typeof body.game === 'string' ? body.game.slice(0, 150) : '';
    if (asked) {
      if (asked.indexOf('house/') === 0) {
        const house = houseGames(env).find((g) => g.id === asked);
        if (house) game = house.id;
      } else {
        const state = await getState(store);
        const rec = Object.keys(state.games).map((k) => state.games[k])
          .find((g) => g && String(g.id).toLowerCase() === asked.toLowerCase());
        if (rec && rec.status === PUBLISHED && !rec.hidden) game = rec.id;
      }
    }

    const token = typeof body.token === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(body.token)
      ? body.token : null;
    const presence = presenceClient(env);

    if (path === '/api/presence/visit') {
      if (!game) return json({ ok: true, counted: false });
      const res = await presence.visit(game, member ? String(member.id) : 'ip:' + ip);
      return json({ ok: true, counted: Boolean(res && res.counted) });
    }
    if (path === '/api/presence/leave') {
      await presence.leave(member && !member.hidePresence ? member.id : null, token);
      return json({ ok: true });
    }
    if (path !== '/api/presence/beat') return errorJson(404, 'no such endpoint');

    /* a member who switched presence off is counted, never named */
    if (member && !member.hidePresence) await presence.beat(member.id, null, game);
    else await presence.beat(null, token || ('anon-' + ip.replace(/[^A-Za-z0-9]/g, '')), game);
    return json({ ok: true });
  }

  /* everything that changes something */
  if (method === 'POST' && (path.startsWith('/api/'))) {
    if (!sameOrigin(request)) return errorJson(403, 'bad origin');
    if (!rateLimit(ip, 'post', 30, 60000)) return errorJson(429, 'slow down a moment');
    const body = await readBody(request);
    if (!body) return errorJson(400, 'send a small JSON body');
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    if (!session) return errorJson(401, 'sign in first');

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

    /* the publish form: details, publish, unpublish, take the picture off */
    if (path === '/api/games/meta' || path === '/api/games/publish' ||
      path === '/api/games/unpublish' || path === '/api/games/cover-remove') {
      if (!isRepoName(body.repo)) return errorJson(400, 'which repo?');
      const game = (await getState(store)).games[keyFor(member.id, body.repo)];
      if (!game) return errorJson(404, 'that game is not yours or not on the Hub');
      hubCache = { at: 0, body: null };

      if (path === '/api/games/meta') {
        const settings = await getSettings(store, env);
        const res = await setGameMeta(store, game, body,
          settings.round && settings.round.category, member.login);
        return res.ok ? json({ ok: true, game: res.game }) : errorJson(400, res.error);
      }
      if (path === '/api/games/cover-remove') {
        await store.delete(coverKey(String(member.id), game.repo));
        await update(store, (st) => {
          const rec = st.games[keyFor(member.id, game.repo)];
          if (rec) rec.cover = null;
        });
        return json({ ok: true });
      }
      const res = await setGameStatus(store, game,
        path === '/api/games/publish' ? PUBLISHED : DRAFT, member.login);
      return res.ok ? json({ ok: true, game: res.game }) : errorJson(400, res.error);
    }

    /* loving a game: one small write, members only, published games only */
    if (path === '/api/games/love') {
      const allow = await allowance(env, store, 'love:' + member.id, LOVES_PER_HOUR, 3600000);
      if (!allow.ok) return errorJson(429, 'that is a lot of loving for one hour');
      const res = await setLove(env, store, body.id, member.id, body.on !== false);
      hubCache = { at: 0, body: null };
      return res.ok
        ? json({ ok: true, loves: res.loves, lovedByMe: res.lovedByMe })
        : errorJson(400, res.error);
    }

    /* "show when I'm online" lives on the member record */
    if (path === '/api/me/presence') {
      const on = body.show !== false;
      await update(store, (st) => {
        const rec = st.members[String(member.id)];
        if (rec) rec.hidePresence = !on;
      });
      hubCache = { at: 0, body: null };
      return json({ ok: true, show: on });
    }

    /* reporting a game: a line in the owner's activity log, nothing public */
    if (path === '/api/games/report') {
      const allow = await allowance(env, store, 'report:' + member.id, REPORTS_PER_DAY, 86400000);
      if (!allow.ok) return errorJson(429, 'you have reported enough for today');
      const res = await reportGame(env, store, body.id, member.login);
      return res.ok ? json({ ok: true }) : errorJson(404, res.error);
    }

    return errorJson(404, 'no such action');
  }

  /* the picture itself */
  if (method === 'GET' && path.startsWith('/img/cover/')) {
    const parts = path.slice('/img/cover/'.length).split('/');
    if (parts.length !== 2) return new Response('no', { status: 404 });
    const ownerKey = decodeURIComponent(parts[0]);
    const repo = decodeURIComponent(parts[1]);
    if (!isOwnerKey(ownerKey) || !isRepoName(repo)) return new Response('no', { status: 404 });
    const store = storeOf(env);

    let isDraft = false;
    if (ownerKey !== 'house') {
      const game = (await getState(store)).games[keyFor(Number(ownerKey), repo)];
      if (!game) return new Response('no', { status: 404 });
      const session = await readSession(request, env, store);
      /* a draft's picture is as private as the draft itself */
      if (!maySee(env, game, session)) return new Response('no', { status: 404 });
      isDraft = game.status !== PUBLISHED;
    }

    const row = await store.getBytes(coverKey(ownerKey, repo));
    if (!row) return new Response('no', { status: 404 });
    return new Response(row.bytes, {
      status: 200,
      headers: {
        'Content-Type': row.type,
        'Content-Length': String(row.bytes.length),
        'Cache-Control': isDraft ? 'private, no-store' : 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cross-Origin-Resource-Policy': 'same-origin'
      }
    });
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
  return withSecurity(res);
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

/*
 * The Durable Object. One instance ("hub") keeps who is here and how many times each
 * game has been opened - things that change every few seconds and would otherwise eat
 * the KV write budget in an evening. All the thinking is in PresenceCore so it can be
 * tested on its own; this is only the wrapper Cloudflare asks for.
 */
export class Presence {
  constructor(state, env) {
    this.state = state;
    this.core = new PresenceCore(state && state.storage, () => Date.now());
  }

  async fetch(request) {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      body = {};
    }
    const out = await this.core.handle(body);
    return new Response(JSON.stringify(out || { ok: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export { handle, withSecurity, HUB_CSP };
