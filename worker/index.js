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
import {
  RoomsCore, roomRequest, serversRequest, gameKeyFromPlayUrl, isPublicId
} from './rooms.js';
import { makeGitHub, makeBudget } from './github.js';
import {
  hubPayload, getSettings, getMember, isAdminId, addGame, removeGame, refresh,
  gamesOfMember, MAX_GAMES_PER_MEMBER, topicOf, setGameMeta, setGameStatus, maySee,
  coverAllowance, putCover, houseGamesWithEdits, addLog, allowance, setFavorite, reportGame,
  FAVORITES_PER_HOUR, REPORTS_PER_DAY, PUBLISHED, DRAFT, houseGames, isHubRepo, storeSweeper,
  houseOwner
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

const PAGE_FOR = {
  '/': '/index.html', '/join': '/join.html', '/admin': '/admin.html',
  '/charts': '/charts.html', '/settings': '/settings.html'
};

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

/*
 * The store, with the sweep hung on it. state.js runs that sweep on the fresh document
 * before every write, which is what keeps the Hub's own repo from ever being a game -
 * whatever route is doing the writing.
 */
function storeOf(env) {
  const store = env.HUB_STORE || (env.HUB ? kvStore(env.HUB) : null);
  if (!store) throw new Error('no storage bound');
  store.sweep = storeSweeper(env);
  return store;
}

/*
 * Whose games may use the rooms: every member's GitHub login, plus the Hub owner's for
 * the house games. One read of the one document, for the two room routes.
 */
async function roomLogins(env) {
  const state = await getState(storeOf(env));
  const logins = new Set([houseOwner(env).toLowerCase()]);
  for (const key of Object.keys(state.members)) {
    const rec = state.members[key];
    if (rec && typeof rec.login === 'string') logins.add(rec.login.toLowerCase());
  }
  return logins;
}

let hubCache = { at: 0, body: null };

/* ---------- the handler ---------- */

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const method = request.method.toUpperCase();
  const ip = clientIp(request);

  /*
   * ROOMS. This is first, and its answer goes back exactly as the object gave it: a
   * WebSocket upgrade is a 101 with a live socket hanging off it, and rebuilding that
   * response (as withSecurity does) would throw the socket away.
   *
   * Everything the client asked for is checked HERE and nowhere else - the object is
   * handed the way in, the game, the finished server key (when the client named one),
   * the clamped max, the player id and the cleaned name, and reads nothing raw.
   */
  if (path === '/room') {
    if (method !== 'GET') return errorJson(405, 'GET only');
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return errorJson(400, 'this address is for a game\'s websocket');
    }
    if (!rateLimit(ip, 'room', 30, 60000)) return errorJson(429, 'slow down a moment');
    const binding = env.PRESENCE;
    if (!binding) return errorJson(503, 'rooms are not switched on');
    const asked = roomRequest(url, request.headers.get('Origin'), await roomLogins(env));
    if (!asked.ok) return errorJson(asked.status, asked.error);
    const stub = binding.get(binding.idFromName('rooms'));
    /* the same request, with a URL that carries only what came back from the check */
    const inside = 'https://rooms.invalid/join?pid=' + encodeURIComponent(asked.pid) +
      '&name=' + encodeURIComponent(asked.name) +
      '&want=' + encodeURIComponent(asked.way) +
      '&game=' + encodeURIComponent(asked.gameKey) +
      '&room=' + encodeURIComponent(asked.room) +
      '&max=' + String(asked.max) + (asked.strict ? '&only=1' : '');
    return stub.fetch(new Request(inside, request));
  }

  /*
   * THE LIST of a game's public servers, for a game that lets a player pick one. Not an
   * upgrade and not a message: it is never counted against the day's message cap, and
   * it never says a word about a private server.
   *
   * It is fetched cross-origin by the library, so its answer is built and returned
   * right here, with the asking origin echoed back after it has been checked - nothing
   * in between is allowed to rebuild it and drop those headers.
   */
  if (path === '/room/servers') {
    if (method !== 'GET') return errorJson(405, 'GET only');
    if (!rateLimit(ip, 'servers', 60, 60000)) return errorJson(429, 'slow down a moment');
    const binding = env.PRESENCE;
    if (!binding) return errorJson(503, 'rooms are not switched on');
    const origin = request.headers.get('Origin');
    const asked = serversRequest(url, origin, await roomLogins(env));
    if (!asked.ok) return errorJson(asked.status, asked.error);
    const stub = binding.get(binding.idFromName('rooms'));
    const res = await stub.fetch(new Request(
      'https://rooms.invalid/servers?game=' + encodeURIComponent(asked.gameKey)
    ));
    let servers = [];
    try {
      const body = await res.json();
      if (body && Array.isArray(body.servers)) servers = body.servers;
    } catch (e) {
      servers = [];
    }
    return json({ ok: true, servers: servers }, 200, {
      /* only ever the origin that was just checked, and never a bare * */
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin'
    });
  }

  /*
   * The little library a member's game loads from here. It is the one file on the Hub
   * meant for another origin: a <script src> on https://<login>.github.io needs it to
   * be readable cross-origin, and a short cache means a fix reaches the games in
   * minutes instead of a day.
   */
  if ((method === 'GET' || method === 'HEAD') && path === '/room.js') {
    if (!env.ASSETS) return new Response('no assets bound', { status: 500 });
    const res = await env.ASSETS.fetch(
      new Request(new URL('/room.js', url.origin).toString(), { method: 'GET' })
    );
    const h = new Headers(res.headers);
    h.set('Content-Type', 'text/javascript; charset=utf-8');
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    h.set('Cache-Control', 'public, max-age=300');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    return new Response(res.body, { status: res.status, headers: h });
  }

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

  /*
   * THE SERVERS OF ONE GAME, for the Hub's own game page.
   *
   * /room/servers above answers a GAME, and works out whose it is from the Origin the
   * browser sets. The Hub's own page has no such Origin to go by - a same-origin fetch
   * sends none - so this is its own route: the game is looked up in the Hub's own data,
   * it has to be one the person asking may see (a published game, or their own draft, or
   * anything if they are an admin), and WHICH rooms it owns is worked out from the play
   * address the Hub itself computed from owner + repo. Nothing here comes from the
   * client but the game's id.
   */
  if (path === '/api/rooms/servers') {
    if (method !== 'GET') return errorJson(405, 'GET only');
    if (!rateLimit(ip, 'gameservers', 60, 60000)) return errorJson(429, 'slow down a moment');
    const wanted = url.searchParams.get('g') || '';
    if (!/^[A-Za-z0-9._/-]{1,140}$/.test(wanted)) return errorJson(400, 'which game?');
    const store = storeOf(env);
    const session = await readSession(request, env, store);
    let game = null;
    if (wanted.indexOf('house/') === 0) {
      game = (await houseGamesWithEdits(env, store)).find((g) => g.id === wanted) || null;
    } else {
      const state = await getState(store);
      game = Object.keys(state.games).map((k) => state.games[k])
        .find((g) => g && String(g.id).toLowerCase() === wanted.toLowerCase()) || null;
    }
    /* a draft is as private here as it is everywhere else */
    if (!game || !maySee(env, game, session)) return errorJson(404, 'no such game');
    const binding = env.PRESENCE;
    /* the one shared rule, so this and the library can never name a game differently */
    const gameKey = gameKeyFromPlayUrl(game.url);
    /* a game whose address is nobody's Pages site has no servers to list */
    if (!binding || !gameKey) return json({ ok: true, servers: [] });
    let servers = [];
    try {
      const stub = binding.get(binding.idFromName('rooms'));
      const res = await stub.fetch(new Request(
        'https://rooms.invalid/servers?game=' + encodeURIComponent(gameKey)
      ));
      const body = await res.json();
      if (body && Array.isArray(body.servers)) servers = body.servers;
    } catch (e) {
      /* the rooms being unreachable is an empty list, never an error page */
      servers = [];
    }
    return json({ ok: true, servers: servers });
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
    const list = repos
      .filter((r) => repoEligible(r, member.id))
      /* the Hub's own repo has Pages on, but it is the Hub, not a game */
      .filter((r) => !isHubRepo(env, member.login, r.name, member.id))
      .map((r) => ({
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
    /*
     * Which server of that game they are in. The shape is checked here as well as in
     * the object: only a public server id ever gets through, so a private server's code
     * cannot be put on a presence row however it is sent.
     */
    const server = isPublicId(body.server) ? String(body.server) : '';
    const presence = presenceClient(env);

    if (path === '/api/presence/visit') {
      if (!game) return json({ ok: true, counted: false });
      const res = await presence.visit(game, member ? String(member.id) : 'ip:' + ip);
      return json({ ok: true, counted: Boolean(res && res.counted) });
    }
    /*
     * Whose own play time this beat belongs to. A member who switched presence off is
     * beaten as a guest - counted, never named - but the time is still theirs, so it is
     * said here separately from the row the beat writes.
     */
    const creditTo = member ? String(member.id) : null;

    if (path === '/api/presence/leave') {
      await presence.leave(member && !member.hidePresence ? member.id : null, token, creditTo);
      return json({ ok: true });
    }
    if (path !== '/api/presence/beat') return errorJson(404, 'no such endpoint');

    /* a member who switched presence off is counted, never named - and a nameless row
       has nobody to join, so it is never told which server either */
    if (member && !member.hidePresence) {
      await presence.beat(member.id, null, game, creditTo, server);
    } else {
      await presence.beat(
        null, token || ('anon-' + ip.replace(/[^A-Za-z0-9]/g, '')), game, creditTo
      );
    }
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

    /*
     * Favouriting a game: one small write, members only, published games only. The
     * answer says whether it is on the asker's own list and nothing else - there is no
     * count to give away, here or anywhere.
     */
    if (path === '/api/games/favorite') {
      const allow = await allowance(env, store, 'fav:' + member.id, FAVORITES_PER_HOUR, 3600000);
      if (!allow.ok) return errorJson(429, 'that is a lot of starring for one hour');
      const res = await setFavorite(env, store, body.id, member.id, body.on !== false);
      hubCache = { at: 0, body: null };
      return res.ok ? json({ ok: true, favorite: res.favorite }) : errorJson(400, res.error);
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

    /* "recently played" is the asker's own row, so only they can empty it */
    if (path === '/api/me/recent-clear') {
      await presenceClient(env).forget(String(member.id));
      return json({ ok: true });
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
 * the KV write budget in an evening. A second instance ("rooms") relays the members'
 * multiplayer games. Same class, two instances, no new migration.
 *
 * All the thinking is in PresenceCore and RoomsCore so both can be tested on their own;
 * this is only the wrapper Cloudflare asks for.
 */
export class Presence {
  constructor(state, env) {
    this.state = state;
    this.core = new PresenceCore(state && state.storage, () => Date.now());
    /* built on the first socket, never before: the "hub" instance never needs it */
    this.rooms = null;
  }

  /* A cache, nothing more: a brand new core on the same storage and the same sockets
     behaves the same, which is exactly what every wake-up gives it. */
  roomsCore() {
    if (!this.rooms) {
      const state = this.state;
      this.rooms = new RoomsCore({
        storage: state && state.storage,
        now: () => Date.now(),
        /* the Hibernation API: ws.accept() would keep this object billed and awake for
           as long as the socket is open */
        accept: (ws, tags) => state.acceptWebSocket(ws, tags),
        sockets: (tag) => (tag === undefined ? state.getWebSockets() : state.getWebSockets(tag))
      });
    }
    return this.rooms;
  }

  async fetch(request) {
    const asked = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      await this.roomsCore().connect(pair[1], {
        game: asked.searchParams.get('game') || '',
        way: asked.searchParams.get('want') || '',
        room: asked.searchParams.get('room') || '',
        max: asked.searchParams.get('max') || '',
        strict: asked.searchParams.get('only') === '1',
        pid: asked.searchParams.get('pid') || '',
        name: asked.searchParams.get('name') || ''
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    /* the list of a game's public servers: read off the sockets, nothing stored, and
       not a message, so the day's count is not touched */
    if (asked.pathname === '/servers') {
      const servers = this.roomsCore().serverList(asked.searchParams.get('game') || '');
      return new Response(JSON.stringify({ ok: true, servers: servers }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
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

  /* The hibernation handlers. They are called on a freshly built object as often as not,
     which is why nothing a room needs is kept in memory. */
  async webSocketMessage(ws, message) {
    await this.roomsCore().message(ws, message);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    await this.roomsCore().close(ws, code, reason, wasClean);
  }

  async webSocketError(ws, err) {
    await this.roomsCore().close(ws, 1011, 'error', false);
  }
}

export { handle, withSecurity, HUB_CSP };
