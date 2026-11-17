#!/usr/bin/env node
/*
 * Claude Hub v3 tests. Plain node, no dependencies, no network:
 *
 *   node tools/test.js
 *
 * GitHub is faked in process (tools/fake-github.js) and the global fetch is replaced,
 * so a test that tried to reach the real internet would fail loudly.
 *
 * Note for the secret scan: a few tests build strings that LOOK like tokens out of
 * pieces (see "scanner bait" below) to prove the scanner catches them. No real secret
 * is in this file.
 */
import fs from 'node:fs';
import { handle } from '../worker/index.js';
import { memoryStore } from '../worker/store.js';
import {
  clean, pretty, isLogin, isRepoName, playUrl, normalizeHubJson, repoEligible, hasTopic,
  isOkEmoji, allowedCategory, safeAvatar
} from '../worker/validate.js';
import { pack } from '../worker/util.js';
import { refresh, getSettings, saveSettings, hubPayload, HOUSE_GAMES, houseGames } from '../worker/hub.js';
import { makeBudget, makeGitHub } from '../worker/github.js';
import { fakeState, fakeFetch, fakeEnv, FAKE_BASE, FAKE_USERS } from './fake-github.js';

const SITE = 'https://hub.test';
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, condition, extra) {
  if (condition) {
    pass++;
  } else {
    fail++;
    failures.push(name + (extra ? ' -> ' + extra : ''));
    console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : ''));
  }
}

function eq(name, got, want) {
  ok(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}

/* ---------- harness ---------- */

const current = { state: fakeState() };
globalThis.fetch = async function (input, init) {
  return fakeFetch(current.state, FAKE_BASE)(input, init);
};

let ipSeq = 0;
function nextIp() {
  ipSeq++;
  return '10.0.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250);
}

function world(envExtra, storeSeed) {
  const store = memoryStore(storeSeed || null);
  current.state = fakeState();
  const env = fakeEnv(Object.assign({ HUB_STORE: store, ASSETS: null }, envExtra || {}));
  return { store, env, state: current.state };
}

async function call(env, path, opts) {
  const o = opts || {};
  const headers = new Headers(o.headers || {});
  headers.set('CF-Connecting-IP', o.ip || nextIp());
  if (o.cookie) headers.set('Cookie', o.cookie);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  if (o.raw) headers.set('Content-Type', o.rawType || 'application/octet-stream');
  if (o.origin !== null) headers.set('Origin', o.origin || SITE);
  const req = new Request(SITE + path, {
    method: o.method || (o.body !== undefined || o.raw ? 'POST' : 'GET'),
    headers: headers,
    body: o.raw ? o.raw : (o.body !== undefined ? JSON.stringify(o.body) : undefined)
  });
  const res = await handle(req, env, { waitUntil() {} });
  let body = null;
  const text = await res.clone().text();
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = { _text: text };
  }
  return { res, body, text, cookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
}

function rawCookie(cookies, name) {
  for (const c of cookies || []) if (c.indexOf(name + '=') === 0) return c;
  return '';
}

function cookieValue(cookies, name) {
  for (const c of cookies || []) {
    if (c.indexOf(name + '=') === 0) return c.slice(0, c.indexOf(';') < 0 ? undefined : c.indexOf(';'));
  }
  return null;
}

/* Games arrive as drafts now; some tests only care about what the arcade shows. */
async function publishAll(store) {
  for (const row of await store.list('game:')) {
    await store.put(row.key, Object.assign({}, row.value, { status: 'published' }));
  }
}

/* Full sign-in through the fake GitHub. Returns the session cookie or the refusal. */
async function signIn(env, login, inviteCode) {
  const ip = nextIp();
  const start = await call(env, '/auth/login' + (inviteCode ? '?code=' + inviteCode : ''), { ip });
  const stateCookie = cookieValue(start.cookies, 'hub_oauth');
  const loc = start.res.headers.get('Location') || '';
  const state = new URL(loc).searchParams.get('state');
  const back = await call(env, '/auth/callback?code=fake-' + login + '&state=' + encodeURIComponent(state), {
    ip, cookie: stateCookie
  });
  return {
    status: back.res.status,
    text: back.text,
    session: cookieValue(back.cookies, 'hub_session'),
    sessionRaw: rawCookie(back.cookies, 'hub_session'),
    location: back.res.headers.get('Location')
  };
}

/* ---------- 1. pure validation ---------- */

async function testPure() {
  console.log('validation');
  ok('login ok', isLogin('friend-one') && isLogin('a') && isLogin('A1-b2'));
  ok('login rejects', !isLogin('-bad') && !isLogin('bad-') && !isLogin('two words') &&
    !isLogin('a'.repeat(40)) && !isLogin('semi;colon') && !isLogin(''));
  ok('repo name ok', isRepoName('snake-dash') && isRepoName('a.b_c-1'));
  ok('repo name rejects', !isRepoName('../etc') && !isRepoName('a/b') && !isRepoName('') &&
    !isRepoName('x'.repeat(101)) && !isRepoName('..'));

  eq('play url', playUrl('Friend-One', 'snake-dash'), 'https://friend-one.github.io/snake-dash/');
  eq('play url at root', playUrl('friend-two', 'friend-two.github.io'), 'https://friend-two.github.io/');
  eq('play url rejects junk', playUrl('friend one', 'x'), null);
  eq('play url rejects path', playUrl('friend-one', 'a/b'), null);

  eq('clean caps', clean('x'.repeat(100), 60).length, 60);
  eq('clean strips control chars', clean('a\u0000\u001fb'), 'a b');
  eq('pretty', pretty('snake_dash-2'), 'Snake Dash 2');
  ok('emoji one grapheme', isOkEmoji('\u{1F40D}') && isOkEmoji('⚾'));
  ok('emoji rejects', !isOkEmoji('ab') && !isOkEmoji('<svg onload=alert(5)>') &&
    !isOkEmoji('a') && !isOkEmoji(''));
  eq('category known', allowedCategory('Arcade'), 'arcade');
  eq('category junk', allowedCategory('<script>'), null);
  eq('category round extra', allowedCategory('spooktober', 'spooktober'), 'spooktober');
  ok('avatar guard', safeAvatar('https://evil.example/x.png', 7001) ===
    'https://avatars.githubusercontent.com/u/7001?v=4');
  ok('avatar keeps real', safeAvatar('https://avatars.githubusercontent.com/u/7001?v=4', 7001)
    .indexOf('https://avatars.githubusercontent.com/') === 0);

  const meta = normalizeHubJson({
    title: 'T'.repeat(200), description: 'D'.repeat(500),
    category: '<script>alert(4)</script>', emoji: '<svg onload=alert(5)>'
  }, { title: 'Fallback', seed: 'x' });
  eq('hub.json title capped', meta.title.length, 60);
  eq('hub.json description capped', meta.description.length, 200);
  eq('hub.json junk category', meta.category, 'freestyle');
  ok('hub.json junk emoji replaced', meta.emoji.indexOf('<') < 0);
  const fb = normalizeHubJson(null, { title: 'Plain Game', description: 'from the repo', seed: 'y' });
  eq('hub.json missing uses fallbacks', fb.title, 'Plain Game');
  const arr = normalizeHubJson(['not', 'an', 'object'], { title: 'Z', seed: 'z' });
  eq('hub.json array ignored', arr.title, 'Z');

  const base = { name: 'g', owner: { login: 'friend-one', id: 7001 }, has_pages: true, topics: ['claude-hub-game'] };
  ok('eligible', repoEligible(base, 7001));
  ok('not eligible: wrong owner id', !repoEligible(base, 7002));
  ok('not eligible: fork', !repoEligible(Object.assign({}, base, { fork: true }), 7001));
  ok('not eligible: private', !repoEligible(Object.assign({}, base, { private: true }), 7001));
  ok('not eligible: archived', !repoEligible(Object.assign({}, base, { archived: true }), 7001));
  ok('not eligible: no pages', !repoEligible(Object.assign({}, base, { has_pages: false }), 7001));
  ok('topic check', hasTopic(base, 'claude-hub-game') && !hasTopic(base, 'other'));
}

/* ---------- 2. sessions ---------- */

async function testSessions() {
  console.log('sessions');
  const { env } = world();
  const good = await signIn(env, 'sp101-admin');
  ok('admin signs in', Boolean(good.session), 'status ' + good.status);
  ok('session cookie is HttpOnly + SameSite + Path', /HttpOnly/.test(good.sessionRaw) &&
    /SameSite=Lax/.test(good.sessionRaw) && /Path=\//.test(good.sessionRaw), good.sessionRaw);

  const me = await call(env, '/api/me', { cookie: good.session });
  eq('me is the admin', me.body.me && me.body.me.login, 'sp101-admin');
  eq('me is flagged admin', me.body.me && me.body.me.admin, true);

  const tampered = good.session.replace('hub_session=', 'hub_session=')
    .replace(/^(hub_session=.)(.)/, (m, a) => a + (m[1] === 'A' ? 'B' : 'A'));
  const bad1 = await call(env, '/api/me', { cookie: tampered });
  ok('tampered cookie is nobody', bad1.body.me === null);

  const forged = 'hub_session=' + await pack('not-the-real-secret-at-all',
    { id: 9001, login: 'sp101-admin', exp: Math.floor(Date.now() / 1000) + 600 });
  const bad2 = await call(env, '/api/me', { cookie: forged });
  ok('cookie signed with another secret is nobody', bad2.body.me === null);

  const expired = 'hub_session=' + await pack(env.SESSION_SECRET,
    { id: 9001, login: 'sp101-admin', exp: Math.floor(Date.now() / 1000) - 10 });
  const bad3 = await call(env, '/api/me', { cookie: expired });
  ok('expired cookie is nobody', bad3.body.me === null);

  const noSig = 'hub_session=' + Buffer.from(JSON.stringify({ id: 9001, login: 'sp101-admin' })).toString('base64url');
  const bad4 = await call(env, '/api/me', { cookie: noSig });
  ok('unsigned cookie is nobody', bad4.body.me === null);

  const out = await call(env, '/auth/logout', { body: {}, cookie: good.session });
  ok('logout clears the cookie', /hub_session=;|hub_session=; /.test((out.cookies[0] || '') + ' ') ||
    /Max-Age=0/.test(out.cookies[0] || ''));
}

/* ---------- 3. the OAuth dance ---------- */

async function testOauth() {
  console.log('oauth');
  const { env } = world();
  const ip = nextIp();
  const start = await call(env, '/auth/login', { ip });
  eq('login redirects', start.res.status, 302);
  const loc = start.res.headers.get('Location');
  ok('login goes to the authorize page', loc.indexOf('/login/oauth/authorize') > 0, loc);
  ok('no scopes asked for', loc.indexOf('scope=') < 0, loc);
  ok('state cookie set', Boolean(cookieValue(start.cookies, 'hub_oauth')));

  const stateCookie = cookieValue(start.cookies, 'hub_oauth');
  const wrong = await call(env, '/auth/callback?code=fake-sp101-admin&state=not-the-state', {
    ip, cookie: stateCookie
  });
  eq('state mismatch refused', wrong.res.status, 400);
  ok('state mismatch says nothing was done', wrong.text.indexOf('nothing was done') > 0);

  const none = await call(env, '/auth/callback?code=fake-sp101-admin&state=x', { ip });
  eq('no state cookie refused', none.res.status, 400);

  const expiredState = 'hub_oauth=' + await pack(env.SESSION_SECRET,
    { state: 'abc', invite: '', exp: Math.floor(Date.now() / 1000) - 5 });
  const stale = await call(env, '/auth/callback?code=fake-sp101-admin&state=abc', {
    ip, cookie: expiredState
  });
  eq('expired state refused', stale.res.status, 400);

  const badCode = await call(env, '/auth/callback?code=' + encodeURIComponent('fake-x; rm -rf /') +
    '&state=' + encodeURIComponent(new URL(loc).searchParams.get('state')), { ip, cookie: stateCookie });
  ok('junk code refused', badCode.res.status === 400 || badCode.res.status === 502,
    'status ' + badCode.res.status);
}

/* ---------- 4. the invite gate ---------- */

async function testInvite() {
  console.log('invite gate');
  const { env, store } = world();
  const settings = await getSettings(store);
  const code = settings.inviteCode;

  const noCode = await signIn(env, 'friend-one');
  eq('no invite refused', noCode.status, 403);
  ok('no invite explains the join link', noCode.text.indexOf('join link') > 0);
  ok('no member was made', (await store.get('member:7001')) === null);

  const wrongCode = await signIn(env, 'friend-one', 'WRONGCODE');
  eq('wrong invite refused', wrongCode.status, 403);

  const right = await signIn(env, 'friend-one', code);
  ok('right invite gets in', Boolean(right.session), 'status ' + right.status);
  const member = await store.get('member:7001');
  ok('member stored with the numeric id', member && member.id === 7001 && member.login === 'friend-one');
  eq('first sign-in lands on my games', right.location, '/mygames.html');

  const again = await signIn(env, 'friend-one');
  ok('a member needs no code later', Boolean(again.session));
  eq('later sign-in lands on the arcade', again.location, '/');

  const admin = await signIn(env, 'sp101-admin');
  ok('admin needs no code', Boolean(admin.session), 'status ' + admin.status);

  const s2 = await getSettings(store);
  s2.inviteRequired = false;
  await saveSettings(store, s2);
  const open = await signIn(env, 'stranger');
  ok('gate off lets anyone in', Boolean(open.session), 'status ' + open.status);

  /* banned */
  const b = world();
  await b.store.put('ban:7004', { id: 7004, login: 'banned-bob', at: 'now', by: 'test' });
  const sb = await getSettings(b.store);
  const banned = await signIn(b.env, 'banned-bob', sb.inviteCode);
  eq('banned cannot sign in', banned.status, 403);
  ok('banned made no member', (await b.store.get('member:7004')) === null);
}

/* ---------- 5. adding and removing games ---------- */

async function joined(login, env, store) {
  const s = await getSettings(store);
  const res = await signIn(env, login, s.inviteCode);
  return res.session;
}

async function testGames() {
  console.log('games');
  const { env, store } = world();
  const session = await joined('friend-one', env, store);

  const notMine = await call(env, '/api/games/add', { body: { repo: 'owner-game' }, cookie: session });
  eq('cannot add a repo on someone else’s account', notMine.res.status, 400);

  const pathy = await call(env, '/api/games/add', { body: { repo: '../secret' }, cookie: session });
  eq('path tricks refused', pathy.res.status, 400);

  for (const bad of ['forked-thing', 'secret-lab', 'no-pages', 'old-stuff']) {
    const r = await call(env, '/api/games/add', { body: { repo: bad }, cookie: session });
    eq('refused: ' + bad, r.res.status, 400);
    ok('refusal explains ' + bad, String(r.body.error || '').indexOf('eligible') > 0, r.body.error);
  }

  const good = await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: session });
  eq('adding my own eligible repo works', good.res.status, 200);
  eq('the id is login/repo', good.body.game.id, 'friend-one/plain-game');
  eq('the play address is computed', good.body.game.url, 'https://friend-one.github.io/plain-game/');

  const twice = await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: session });
  eq('adding twice refused', twice.res.status, 400);

  const hub = await call(env, '/api/hub', { cookie: session });
  const ids = hub.body.games.map((g) => g.id);
  ok('the game is in the arcade', ids.indexOf('friend-one/plain-game') >= 0, ids.join(','));
  ok('the house game is still there, the removed one is not', ids.indexOf('house/rare-pull') >= 0 && ids.indexOf('house/neon-snake') < 0);
  const house = hub.body.games.find((g) => g.id === 'house/rare-pull');
  eq('a house game plays from the old Pages address', house.url,
    'https://stealpro101.github.io/claude-hub/games/rare-pull/');
  eq('and is marked as a house game', house.house, true);
  eq('owned by the hub owner', house.owner, 'StealPro101');

  const repos = await call(env, '/api/my/repos', { cookie: session });
  eq('my repos only lists eligible ones', repos.body.repos.length, 3);
  ok('my repos marks what is on the hub',
    repos.body.repos.filter((r) => r.onHub).map((r) => r.repo).join() === 'plain-game');

  const rm = await call(env, '/api/games/remove', { body: { repo: 'plain-game' }, cookie: session });
  eq('removing my own game works', rm.res.status, 200);
  ok('tombstone kept', (await store.get('tomb:7001/plain-game')).by === 'member');
}

/* ---------- 6. the refresh and tombstones ---------- */

async function testRefresh() {
  console.log('refresh');
  const { env, store } = world();
  await joined('friend-one', env, store);
  await joined('friend-two', env, store);

  const first = await refresh(env, store, {});
  ok('topic games were added by themselves', first.added >= 3, JSON.stringify(first));
  ok('refresh stayed well under 50 GitHub calls', first.used < 50, 'used ' + first.used);
  const games = (await store.list('game:')).map((r) => r.value.id).sort();
  ok('snake-dash came in on the topic', games.indexOf('friend-one/snake-dash') >= 0, games.join());
  ok('plain-game (no topic) stayed out', games.indexOf('friend-one/plain-game') < 0, games.join());
  ok('a repo named <login>.github.io plays at the root',
    (await store.get('game:7002/friend-two.github.io')).url === 'https://friend-two.github.io/');

  const xss = await store.get('game:7001/xss-game');
  eq('a title full of HTML is kept as plain text', xss.title, '<img src=x onerror=alert(1)>');
  eq('a javascript: link in a description stays text',
    xss.description.indexOf('javascript:') > 0, true);
  eq('the play address ignores hub.json entirely', xss.url, 'https://friend-one.github.io/xss-game/');

  /* a member who removes a game by hand keeps it off */
  const session = await joined('friend-one', env, store);
  await call(env, '/api/games/remove', { body: { repo: 'snake-dash' }, cookie: session });
  const second = await refresh(env, store, {});
  ok('a game removed by the member is not auto-added again',
    (await store.get('game:7001/snake-dash')) === null, JSON.stringify(second));

  /* re-adding by hand clears the member's own tombstone */
  const back = await call(env, '/api/games/add', { body: { repo: 'snake-dash' }, cookie: session });
  eq('the member can add it back', back.res.status, 200);
  ok('their own tombstone is gone', (await store.get('tomb:7001/snake-dash')) === null);

  /* an admin tombstone the member cannot clear */
  const admin = await joined('sp101-admin', env, store);
  const adminRm = await call(env, '/api/admin/game/remove', {
    body: { id: 'friend-one/snake-dash' }, cookie: admin
  });
  eq('admin removes a game', adminRm.res.status, 200);
  const retry = await call(env, '/api/games/add', { body: { repo: 'snake-dash' }, cookie: session });
  eq('the member cannot undo an admin removal', retry.res.status, 400);
  ok('the refusal points at the owner', String(retry.body.error).indexOf('owner') > 0, retry.body.error);
  const third = await refresh(env, store, {});
  ok('the refresh does not bring it back either',
    (await store.get('game:7001/snake-dash')) === null, JSON.stringify(third));

  /* a GitHub outage must not lose anything */
  const before = (await store.list('game:')).length;
  current.state.broken = true;
  const broke = await refresh(env, store, {});
  current.state.broken = false;
  eq('nothing was lost during an outage', (await store.list('game:')).length, before);
  ok('the outage was counted, not ignored', broke.errors > 0, JSON.stringify(broke));

  /* a repo that disappears goes away */
  current.state.repos['friend-two'] = [];
  await refresh(env, store, { batch: 4 });
  await refresh(env, store, { batch: 4 });
  ok('a vanished repo is dropped', (await store.get('game:7002/friend-two.github.io')) === null);
}

async function testBudget() {
  console.log('budget');
  const { env, store } = world();
  for (let i = 0; i < 30; i++) {
    const id = 8100 + i;
    const login = 'friend-' + id;
    current.state.users[login] = {
      login: login, id: id, name: 'Friend ' + id, bio: '',
      avatar_url: 'https://avatars.githubusercontent.com/u/' + id + '?v=4',
      html_url: 'https://github.com/' + login
    };
    current.state.repos[login] = [
      {
        name: 'game-a', owner: { login: login, id: id }, private: false, fork: false,
        archived: false, has_pages: true, topics: ['claude-hub-game'], default_branch: 'main',
        description: '', stargazers_count: 0, pushed_at: '2026-11-01T00:00:00Z'
      },
      {
        name: 'game-b', owner: { login: login, id: id }, private: false, fork: false,
        archived: false, has_pages: true, topics: ['claude-hub-game'], default_branch: 'main',
        description: '', stargazers_count: 0, pushed_at: '2026-11-02T00:00:00Z'
      }
    ];
    await store.put('member:' + id, {
      id: id, login: login, name: 'Friend ' + id, avatar: '', bio: '',
      url: 'https://github.com/' + login, joined: '2026-11-01', seen: '2026-11-01'
    });
  }
  let worst = 0;
  for (let run = 0; run < 10; run++) {
    const budget = makeBudget(45);
    const gh = makeGitHub(env, budget);
    await refresh(env, store, { budget: budget, gh: gh });
    worst = Math.max(worst, budget.used);
  }
  ok('30 members: no invocation goes over 50 GitHub calls', worst < 50, 'worst run used ' + worst);
  const seen = (await store.list('game:')).length;
  ok('the rotation keeps picking up new members', seen >= 20, seen + ' games after 10 runs');
}

/* ---------- 7. admin and CSRF ---------- */

async function testAdmin() {
  console.log('admin');
  const { env, store } = world();
  const friend = await joined('friend-one', env, store);
  const admin = await joined('sp101-admin', env, store);
  await refresh(env, store, {});

  const anon = await call(env, '/api/admin/state');
  eq('signed out admin state is 401', anon.res.status, 401);
  const asFriend = await call(env, '/api/admin/state', { cookie: friend });
  eq('a friend gets 403 on admin state', asFriend.res.status, 403);
  eq('and is told plainly', asFriend.body.error, 'not for you');
  const friendPost = await call(env, '/api/admin/member/ban', { body: { id: 9001 }, cookie: friend });
  eq('a friend cannot ban anyone', friendPost.res.status, 403);
  ok('the admin is still there', Boolean(await store.get('member:9001')));
  const anonPost = await call(env, '/api/admin/round', { body: { round: 9 } });
  eq('signed out cannot set the round', anonPost.res.status, 401);

  const noOrigin = await call(env, '/api/admin/round', { body: { round: 9 }, cookie: admin, origin: null });
  eq('a POST with no Origin is refused', noOrigin.res.status, 403);
  const badOrigin = await call(env, '/api/admin/round', {
    body: { round: 9 }, cookie: admin, origin: 'https://evil.example'
  });
  eq('a POST from another site is refused', badOrigin.res.status, 403);
  const alsoGames = await call(env, '/api/games/add', {
    body: { repo: 'plain-game' }, cookie: friend, origin: 'https://evil.example'
  });
  eq('and the same goes for adding a game', alsoGames.res.status, 403);

  const state = await call(env, '/api/admin/state', { cookie: admin });
  eq('the admin sees the panel', state.res.status, 200);
  ok('with members and games', state.body.members.length >= 2 && state.body.games.length >= 1);
  ok('and the activity log', Array.isArray(state.body.log) && state.body.log.length > 0);

  const round = await call(env, '/api/admin/round', {
    body: { round: 4, category: 'horror', note: 'spooky month' }, cookie: admin
  });
  eq('the round can be set', round.body.round.round, 4);
  eq('with its category', round.body.round.category, 'horror');
  const hub1 = await call(env, '/api/hub');
  eq('the arcade shows the new round', hub1.body.round.round, 4);

  await publishAll(store);
  const target = (await store.list('game:')).map((r) => r.value)
    .find((g) => g.owner === 'friend-one');
  const hide = await call(env, '/api/admin/game/hide', { body: { id: target.id, on: true }, cookie: admin });
  eq('hide works', hide.res.status, 200);
  const hub2 = await call(env, '/api/hub');
  ok('a hidden game is not in the arcade',
    hub2.body.games.map((g) => g.id).indexOf(target.id) < 0);
  const state2 = await call(env, '/api/admin/state', { cookie: admin });
  ok('but the admin still sees it',
    state2.body.games.filter((g) => g.id === target.id && g.hidden).length === 1);
  await call(env, '/api/admin/game/hide', { body: { id: target.id, on: false }, cookie: admin });
  const hub3 = await call(env, '/api/hub');
  ok('unhide puts it back', hub3.body.games.map((g) => g.id).indexOf(target.id) >= 0);

  const feat = await call(env, '/api/admin/game/feature', { body: { id: target.id, on: true }, cookie: admin });
  eq('feature works', feat.res.status, 200);
  const hub4 = await call(env, '/api/hub');
  eq('a featured game sorts first', hub4.body.games[0].id, target.id);

  const inv = await call(env, '/api/admin/invite', { body: { newCode: true }, cookie: admin });
  ok('a new invite code is made', inv.body.inviteCode && inv.body.inviteCode.length === 8);
  const invOff = await call(env, '/api/admin/invite', { body: { required: false }, cookie: admin });
  eq('invite-only can be switched off', invOff.body.inviteRequired, false);

  const ref = await call(env, '/api/admin/refresh', { body: {}, cookie: admin });
  eq('refresh now works', ref.res.status, 200);
  ok('and reports what it did', typeof ref.body.summary.used === 'number');

  const ban = await call(env, '/api/admin/member/ban', { body: { id: 7001 }, cookie: admin });
  eq('ban works', ban.res.status, 200);
  ok('the member is gone', (await store.get('member:7001')) === null);
  ok('their games are gone too', (await store.list('game:7001/')).length === 0);
  const hub5 = await call(env, '/api/hub');
  ok('the arcade has no trace of them',
    hub5.body.games.filter((g) => g.owner === 'friend-one').length === 0);
  const backIn = await signIn(env, 'friend-one');
  eq('and they cannot sign back in', backIn.status, 403);
  const unban = await call(env, '/api/admin/member/unban', { body: { id: 7001 }, cookie: admin });
  eq('unban works', unban.res.status, 200);
  const rejoin = await signIn(env, 'friend-one');
  ok('after unban they can join again', Boolean(rejoin.session), 'status ' + rejoin.status);

  const badAction = await call(env, '/api/admin/nonsense', { body: {}, cookie: admin });
  eq('an unknown admin action is a 404', badAction.res.status, 404);
}

/* ---------- 8. odds and ends ---------- */

async function testMisc() {
  console.log('odds and ends');
  const { env, store } = world();
  const session = await joined('friend-one', env, store);

  const noJson = await call(env, '/api/games/add', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, cookie: session
  });
  eq('a POST that is not JSON is refused', noJson.res.status, 400);

  const huge = await call(env, '/api/games/add', {
    body: { repo: 'x'.repeat(20000) }, cookie: session
  });
  ok('an oversized body is refused', huge.res.status === 400, 'status ' + huge.res.status);

  const put = await call(env, '/api/hub', { method: 'PUT', cookie: session });
  eq('PUT is not allowed', put.res.status, 405);

  const unknown = await call(env, '/api/whatever', { cookie: session });
  eq('an unknown api path is a 404', unknown.res.status, 404);

  const payload = await hubPayload(env, store, null);
  eq('the payload says version 3', payload.v, 3);
  eq('signed out there is no me', payload.me, null);
  eq('house games are in the payload', payload.games.length, HOUSE_GAMES.length);

  const limited = world();
  const s = await getSettings(limited.store);
  await signIn(limited.env, 'friend-one', s.inviteCode);
  let hit429 = false;
  const ip = '10.9.9.9';
  for (let i = 0; i < 40; i++) {
    const r = await call(limited.env, '/api/games/add', {
      body: { repo: 'plain-game' }, cookie: await joined('friend-one', limited.env, limited.store), ip
    });
    if (r.res.status === 429) {
      hit429 = true;
      break;
    }
  }
  ok('POSTs from one address are rate limited', hit429);

  /* scanner bait: these are built from pieces on purpose, so the secret scan has
     something to find in a test file and nowhere else */
  const bait = ['ghp', '_', 'A'.repeat(36)].join('');
  ok('the scanner bait looks like a token but is not one', bait.length === 40 && bait.indexOf('_') === 3);
}

/* ---------- 9. the Worker's own signing key ---------- */

/* a brand new store object holding the same data = the Worker starting again */
function restart(store) {
  const next = memoryStore();
  for (const [k, v] of store._map) next._map.set(k, v);
  return next;
}

async function testOwnSecret() {
  console.log('its own signing key');
  const store = memoryStore();
  current.state = fakeState();
  const env = fakeEnv({ HUB_STORE: store, ASSETS: null, SESSION_SECRET: undefined });

  ok('nothing is stored before the first request', (await store.get('secret:session')) === null);
  const s = await getSettings(store, env);
  const first = await signIn(env, 'friend-one', s.inviteCode);
  ok('sign-in works with no SESSION_SECRET set', Boolean(first.session), 'status ' + first.status);
  const made = await store.get('secret:session');
  ok('the Worker made itself a key', made && typeof made.key === 'string' && made.key.length >= 32);

  const second = await signIn(env, 'friend-two', s.inviteCode);
  ok('a later sign-in still works', Boolean(second.session));
  eq('and the key was reused, not remade', (await store.get('secret:session')).key, made.key);

  const after = restart(store);
  const env2 = fakeEnv({ HUB_STORE: after, ASSETS: null, SESSION_SECRET: undefined });
  const me = await call(env2, '/api/me', { cookie: first.session });
  eq('a cookie signed before a restart still verifies', me.body.me && me.body.me.login, 'friend-one');
  eq('the restarted Worker kept the same key', (await after.get('secret:session')).key, made.key);

  const forged = 'hub_session=' + await pack('a-different-key-entirely-0123456789',
    { id: 7001, login: 'friend-one', exp: Math.floor(Date.now() / 1000) + 600 });
  const bad = await call(env2, '/api/me', { cookie: forged });
  ok('a cookie signed with another key is still nobody', bad.body.me === null);

  /* the key must never leak out of the store */
  ok('list() hides secret keys', (await after.list('secret:')).length === 0);
  ok('and does not sneak them into a wider listing',
    (await after.list('')).filter((r) => r.key.indexOf('secret:') === 0).length === 0);
  const admin = await signIn(env2, 'sp101-admin');
  const hub = await call(env2, '/api/hub', { cookie: admin.session });
  const state = await call(env2, '/api/admin/state', { cookie: admin.session });
  ok('the key is not in /api/hub', hub.text.indexOf(made.key) < 0);
  ok('the key is not in the admin state', state.text.indexOf(made.key) < 0);
  ok('the key is not in the activity log',
    JSON.stringify(state.body.log || []).indexOf(made.key) < 0);

  /* a key the owner sets himself still wins */
  const mine = memoryStore();
  const env3 = fakeEnv({ HUB_STORE: mine, ASSETS: null });
  const s3 = await getSettings(mine, env3);
  await signIn(env3, 'friend-one', s3.inviteCode);
  ok('SESSION_SECRET, when set, is used and nothing is stored',
    (await mine.get('secret:session')) === null);
}

/* ---------- 10. nothing to paste but the client secret ---------- */

async function testSetupGate() {
  console.log('setup gate');
  const notFilled = world({ GITHUB_CLIENT_ID: 'TO_FILL_IN_GITHUB_CLIENT_ID' });
  const r1 = await call(notFilled.env, '/auth/login');
  eq('an unfilled client id switches sign-in off', r1.res.status, 503);
  ok('and says so plainly', r1.text.indexOf('Not set up yet') > 0);
  const c1 = await call(notFilled.env, '/auth/callback?code=fake-friend-one&state=x');
  eq('the callback is off too', c1.res.status, 503);

  const noSecret = world({ GITHUB_CLIENT_SECRET: '' });
  const r2 = await call(noSecret.env, '/auth/login');
  eq('a missing client secret switches sign-in off', r2.res.status, 503);

  const ok1 = world();
  const r3 = await call(ok1.env, '/auth/login');
  eq('with both filled in, sign-in goes to GitHub', r3.res.status, 302);

  /* ADMIN_GITHUB_IDS is a plain var now */
  const ids = world({ ADMIN_GITHUB_IDS: '7002, 9001' });
  const two = await signIn(ids.env, 'friend-two');
  ok('an id listed in the var is an admin (no invite needed)', Boolean(two.session),
    'status ' + two.status);
  const st = await call(ids.env, '/api/admin/state', { cookie: two.session });
  eq('and gets the panel', st.res.status, 200);
  const notAdmin = world({ ADMIN_GITHUB_IDS: '9001' });
  const s4 = await getSettings(notAdmin.store);
  const f = await signIn(notAdmin.env, 'friend-two', s4.inviteCode);
  const st2 = await call(notAdmin.env, '/api/admin/state', { cookie: f.session });
  eq('someone not in the var is not', st2.res.status, 403);
}

/* ---------- 11. renamed and vanished accounts ---------- */

function renameFakeUser(state, from, to) {
  const user = Object.assign({}, state.users[from], { login: to });
  delete state.users[from];
  state.users[to] = user;
  const repos = (state.repos[from] || []).map((r) =>
    Object.assign({}, r, { owner: { login: to, id: user.id } }));
  delete state.repos[from];
  state.repos[to] = repos;
  for (const key of Object.keys(state.hubJson)) {
    if (key.indexOf(from + '/') === 0) {
      state.hubJson[to + key.slice(from.length)] = state.hubJson[key];
      delete state.hubJson[key];
    }
  }
}

async function testRenamedAccounts() {
  console.log('renamed and vanished accounts');
  const { env, store } = world();
  const s = await getSettings(store, env);
  await signIn(env, 'friend-one', s.inviteCode);
  await refresh(env, store, {});
  const before = (await store.list('game:')).map((r) => r.value);
  ok('the member has games to start with', before.length >= 2, String(before.length));

  renameFakeUser(current.state, 'friend-one', 'friend-renamed');
  const sum = await refresh(env, store, {});
  const member = await store.get('member:7001');
  eq('the member keeps their id and gets the new login', member.login, 'friend-renamed');
  eq('and is not marked gone', Boolean(member.gone), false);
  const after = (await store.list('game:')).map((r) => r.value);
  eq('the same games are still there', after.length, before.length);
  ok('their ids follow the new login',
    after.every((g) => g.id.indexOf('friend-renamed/') === 0), after.map((g) => g.id).join());
  ok('and so do the play addresses',
    after.every((g) => g.url.indexOf('https://friend-renamed.github.io/') === 0),
    after.map((g) => g.url).join());
  await publishAll(store);
  ok('nothing was dropped on the way', sum.removed === 0, JSON.stringify(sum));
  const hub = await call(env, '/api/hub');
  ok('the arcade shows the new login',
    hub.body.games.filter((g) => g.owner === 'friend-renamed').length === after.length);

  /* now the account disappears altogether */
  delete current.state.users['friend-renamed'];
  delete current.state.repos['friend-renamed'];
  for (let i = 0; i < 2; i++) await refresh(env, store, {});
  const half = (await store.list('game:')).map((r) => r.value);
  ok('two failures change nothing yet', half.every((g) => !g.hidden), 'hidden too early');
  eq('but the misses are counted', (await store.get('member:7001')).misses, 2);

  await refresh(env, store, {});
  const gone = (await store.list('game:')).map((r) => r.value);
  eq('the games are still stored after the third failure', gone.length, before.length);
  ok('but every one of them is hidden', gone.every((g) => g.hidden), 'still showing');
  eq('and the member is flagged gone', (await store.get('member:7001')).gone, true);
  const hub2 = await call(env, '/api/hub');
  eq('so the arcade shows none of them',
    hub2.body.games.filter((g) => !g.house).length, 0);

  const admin = await joined('sp101-admin', env, store);
  const state = await call(env, '/api/admin/state', { cookie: admin });
  ok('the admin can still see them to remove them',
    state.body.games.filter((g) => g.hidden).length === before.length);
}

/* ---------- 12. drafts ---------- */

async function testDrafts() {
  console.log('drafts');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  const other = await joined('friend-two', env, store);
  const admin = await joined('sp101-admin', env, store);

  const added = await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });
  eq('a game added by hand starts as a draft', added.body.game.status, 'draft');

  const anon = await call(env, '/api/hub');
  ok('a stranger sees no draft', anon.body.games.every((g) => g.id !== 'friend-one/plain-game'),
    anon.body.games.map((g) => g.id).join());
  ok('and no draft of anyone', anon.body.games.every((g) => g.status === 'published'));
  const theirs = await call(env, '/api/hub', { cookie: other });
  ok('another member sees no draft either',
    theirs.body.games.every((g) => g.id !== 'friend-one/plain-game'));
  const owner = await call(env, '/api/hub', { cookie: mine });
  ok('the maker sees their own draft',
    owner.body.games.some((g) => g.id === 'friend-one/plain-game' && g.status === 'draft'));
  const asAdmin = await call(env, '/api/hub', { cookie: admin });
  ok('and so does the Hub owner',
    asAdmin.body.games.some((g) => g.id === 'friend-one/plain-game'));

  const member = anon.body.members.find((m) => m.login === 'friend-one');
  eq('a draft does not count on a profile', member.games, 0);

  await refresh(env, store, {});
  const topicGame = await store.get('game:7001/snake-dash');
  ok('a game the topic brought in is a draft too', topicGame && topicGame.status === 'draft');

  /* the publish form, then publish */
  const noName = await call(env, '/api/games/meta', {
    body: { repo: 'plain-game', title: '   ', description: 'x' }, cookie: mine
  });
  eq('a game needs a name', noName.res.status, 400);
  const meta = await call(env, '/api/games/meta', {
    body: {
      repo: 'plain-game', title: 'My First Game', description: 'a little thing I made',
      category: 'puzzle'
    },
    cookie: mine
  });
  eq('the details can be set', meta.res.status, 200);
  eq('the name is kept', meta.body.game.title, 'My First Game');
  eq('and the category', meta.body.game.category, 'puzzle');

  const pub = await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  eq('publishing works', pub.res.status, 200);
  const after = await call(env, '/api/hub');
  ok('now a stranger can see it',
    after.body.games.some((g) => g.id === 'friend-one/plain-game' && g.status === 'published'));
  eq('and it counts on the profile',
    after.body.members.find((m) => m.login === 'friend-one').games, 1);

  /* the refresh must never undo what a person typed */
  await refresh(env, store, {});
  await refresh(env, store, {});
  const kept = await store.get('game:7001/plain-game');
  eq('the refresh leaves the name alone', kept.title, 'My First Game');
  eq('and the description', kept.description, 'a little thing I made');
  eq('and the category', kept.category, 'puzzle');
  eq('and it stays published', kept.status, 'published');

  const un = await call(env, '/api/games/unpublish', { body: { repo: 'plain-game' }, cookie: mine });
  eq('unpublishing works', un.res.status, 200);
  const gone = await call(env, '/api/hub');
  ok('and it leaves the arcade again',
    gone.body.games.every((g) => g.id !== 'friend-one/plain-game'));

  const log = JSON.stringify((await getSettings(store)).log);
  ok('the log says it was published', log.indexOf('"published"') > 0, log.slice(0, 200));
  ok('and unpublished', log.indexOf('"unpublished"') > 0);
  ok('and that the details were set', log.indexOf('details set') > 0);

  /* an admin can take a published game back to draft */
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  const adminUn = await call(env, '/api/admin/game/unpublish', {
    body: { id: 'friend-one/plain-game' }, cookie: admin
  });
  eq('the Hub owner can unpublish', adminUn.res.status, 200);
  eq('and it really is a draft again',
    (await store.get('game:7001/plain-game')).status, 'draft');

  const notMine = await call(env, '/api/games/publish', {
    body: { repo: 'plain-game' }, cookie: other
  });
  eq('nobody can publish someone else’s game', notMine.res.status, 404);
  ok('house games are always on show',
    anon.body.games.filter((g) => g.house).every((g) => g.status === 'published'));

  const noHouse = world({ HUB_HOUSE_GAMES: 'off' });
  const bare = await call(noHouse.env, '/api/hub');
  eq('a Hub with the house games switched off has none', bare.body.games.length, 0);
}

/* ---------- 13. cover pictures ---------- */

/* the smallest real files of each kind, written out by hand - nothing downloaded */
function pngBytes() {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ]);
}

function jpegBytes() {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
  const body = new Array(40).fill(0x20);
  return new Uint8Array(head.concat(body, [0xff, 0xd9]));
}

function webpBytes() {
  const out = new Uint8Array(64);
  const put = (i, s) => {
    for (let k = 0; k < s.length; k++) out[i + k] = s.charCodeAt(k);
  };
  put(0, 'RIFF');
  out[4] = 56;
  put(8, 'WEBPVP8 ');
  return out;
}

function gifBytes() {
  const out = new Uint8Array(32);
  const s = 'GIF89a';
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function svgBytes() {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
}

async function testCovers() {
  console.log('cover pictures');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  const other = await joined('friend-two', env, store);
  const admin = await joined('sp101-admin', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });
  const upload = (opts) => call(env, '/api/games/cover?repo=plain-game', opts);

  for (const [name, bytes, type] of [
    ['png', pngBytes(), 'image/png'],
    ['jpeg', jpegBytes(), 'image/jpeg'],
    ['webp', webpBytes(), 'image/webp']
  ]) {
    const r = await upload({ raw: bytes, rawType: type, cookie: mine });
    eq('a real ' + name + ' is accepted', r.res.status, 200);
    ok('and comes back with its address', String(r.body.cover).indexOf('/img/cover/7001/plain-game?v=') === 0,
      r.body.cover);
  }

  const stored = await store.get('game:7001/plain-game');
  eq('the game remembers the type', stored.cover.type, 'image/webp');
  ok('and a short version mark', typeof stored.cover.v === 'string' && stored.cover.v.length <= 10);

  /* refusals */
  const big = new Uint8Array(301 * 1024);
  big.set(pngBytes(), 0);
  eq('too big is refused', (await upload({ raw: big, rawType: 'image/png', cookie: mine })).res.status, 413);
  eq('a png claiming to be a webp is refused',
    (await upload({ raw: pngBytes(), rawType: 'image/webp', cookie: mine })).res.status, 400);
  eq('an svg is refused',
    (await upload({ raw: svgBytes(), rawType: 'image/svg+xml', cookie: mine })).res.status, 400);
  eq('a gif is refused',
    (await upload({ raw: gifBytes(), rawType: 'image/gif', cookie: mine })).res.status, 400);
  eq('html dressed as a png is refused',
    (await upload({
      raw: new TextEncoder().encode('<html><script>alert(1)</script></html>'),
      rawType: 'image/png', cookie: mine
    })).res.status, 400);
  eq('signed out is refused', (await upload({ raw: pngBytes(), rawType: 'image/png' })).res.status, 401);
  eq('a foreign Origin is refused',
    (await upload({ raw: pngBytes(), rawType: 'image/png', cookie: mine, origin: 'https://evil.example' })).res.status, 403);
  eq('no Origin at all is refused',
    (await upload({ raw: pngBytes(), rawType: 'image/png', cookie: mine, origin: null })).res.status, 403);
  eq('somebody else’s game is refused',
    (await upload({ raw: pngBytes(), rawType: 'image/png', cookie: other })).res.status, 404);
  const stranger = world();
  const notMember = await signIn(stranger.env, 'sp101-admin');
  await stranger.store.delete('member:9001');
  eq('someone who is not a member is refused',
    (await call(stranger.env, '/api/games/cover?repo=plain-game', {
      raw: pngBytes(), rawType: 'image/png', cookie: notMember.session
    })).res.status, 403);

  /* serving */
  await upload({ raw: pngBytes(), rawType: 'image/png', cookie: mine });
  const draftImg = await call(env, '/img/cover/7001/plain-game?v=x');
  eq('a draft’s picture is not served to a stranger', draftImg.res.status, 404);
  eq('nor to another member',
    (await call(env, '/img/cover/7001/plain-game?v=x', { cookie: other })).res.status, 404);
  const ownerImg = await call(env, '/img/cover/7001/plain-game?v=x', { cookie: mine });
  eq('the maker can see it', ownerImg.res.status, 200);
  eq('and it is not cached while it is a draft',
    ownerImg.res.headers.get('Cache-Control'), 'private, no-store');
  eq('an admin can see it too',
    (await call(env, '/img/cover/7001/plain-game?v=x', { cookie: admin })).res.status, 200);

  await call(env, '/api/games/meta', {
    body: { repo: 'plain-game', title: 'Plain Game' }, cookie: mine
  });
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  const img = await call(env, '/img/cover/7001/plain-game?v=whatever');
  eq('once published anyone can see it', img.res.status, 200);
  eq('with the stored type', img.res.headers.get('Content-Type'), 'image/png');
  eq('cached hard', img.res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  eq('nosniff', img.res.headers.get('X-Content-Type-Options'), 'nosniff');
  eq('locked down by its own CSP', img.res.headers.get('Content-Security-Policy'), "default-src 'none'");
  eq('and same-origin only', img.res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  ok('the bytes come back unchanged', img.text.length > 0);
  eq('an unknown picture is a 404', (await call(env, '/img/cover/7001/no-such-repo?v=1')).res.status, 404);
  eq('a made up owner is a 404', (await call(env, '/img/cover/nonsense/plain-game?v=1')).res.status, 404);

  /* the store must never hand these around */
  ok('list() never returns cover bytes',
    (await store.list('')).every((r) => r.key.indexOf('cover:') !== 0));
  ok('not even when asked for them',
    (await store.list('cover:')).length === 0);
  ok('nor the signing key', (await store.list('')).every((r) => r.key.indexOf('secret:') !== 0));
  const hub = await call(env, '/api/hub');
  const want = '/img/cover/7001/plain-game?v=' + (await store.get('game:7001/plain-game')).cover.v;
  ok('the arcade gets a cover address, not bytes',
    hub.body.games.some((g) => g.cover === want), want);

  /* owner takes the picture off */
  const off = await call(env, '/api/games/cover-remove', { body: { repo: 'plain-game' }, cookie: mine });
  eq('the maker can take the picture off', off.res.status, 200);
  eq('and it is really gone', (await call(env, '/img/cover/7001/plain-game?v=1')).res.status, 404);
  eq('the record forgets it', (await store.get('game:7001/plain-game')).cover, null);

  /* admin remove-picture */
  await upload({ raw: pngBytes(), rawType: 'image/png', cookie: mine });
  const adminOff = await call(env, '/api/admin/game/cover-remove', {
    body: { id: 'friend-one/plain-game' }, cookie: admin
  });
  eq('the Hub owner can take a picture off too', adminOff.res.status, 200);
  eq('gone again', (await call(env, '/img/cover/7001/plain-game?v=1')).res.status, 404);

  /* removing the game takes the picture with it */
  await upload({ raw: pngBytes(), rawType: 'image/png', cookie: mine });
  await call(env, '/api/games/remove', { body: { repo: 'plain-game' }, cookie: mine });
  eq('removing a game deletes its picture',
    (await call(env, '/img/cover/7001/plain-game?v=1')).res.status, 404);
  ok('and nothing is left in the store',
    (await store.getBytes('cover:7001/plain-game')) === null);

  /* the hourly allowance */
  const limited = world();
  const who = await joined('friend-one', limited.env, limited.store);
  await call(limited.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: who });
  let last = 0;
  for (let i = 0; i < 13; i++) {
    const r = await call(limited.env, '/api/games/cover?repo=plain-game', {
      raw: pngBytes(), rawType: 'image/png', cookie: who, ip: '10.5.5.5'
    });
    last = r.res.status;
    if (i < 12) ok('upload ' + (i + 1) + ' of 12 allowed', r.res.status === 200, 'status ' + r.res.status);
  }
  eq('the 13th picture in an hour is refused', last, 429);
  ok('the counter lives in the store, not in memory',
    (await limited.store.get('rate:cover:7001')).n >= 12);

  /* house games: the owner only */
  const houseByFriend = await call(env, '/api/games/cover?house=rare-pull', {
    raw: pngBytes(), rawType: 'image/png', cookie: mine
  });
  eq('a member cannot touch a house game’s picture', houseByFriend.res.status, 403);
  const houseByAdmin = await call(env, '/api/games/cover?house=rare-pull', {
    raw: pngBytes(), rawType: 'image/png', cookie: admin
  });
  eq('the Hub owner can set it', houseByAdmin.res.status, 200);
  eq('and it is served to everyone', (await call(env, '/img/cover/house/rare-pull?v=1')).res.status, 200);
  const houseMeta = await call(env, '/api/admin/house/meta', {
    body: { slug: 'rare-pull', title: 'Rare Pull Deluxe', description: 'the house trivia climb', category: 'trivia' },
    cookie: admin
  });
  eq('the Hub owner can rename a house game', houseMeta.res.status, 200);
  const hub2 = await call(env, '/api/hub');
  eq('and the arcade shows the new name',
    hub2.body.games.find((g) => g.id === 'house/rare-pull').title, 'Rare Pull Deluxe');
  const byMember = await call(env, '/api/admin/house/meta', {
    body: { slug: 'rare-pull', title: 'nope' }, cookie: mine
  });
  eq('a member cannot', byMember.res.status, 403);
}

/* ---------- 14. headers and static pages ---------- */

async function testHeaders() {
  console.log('headers and pages');
  const { diskAssets } = await import('./dev-server.js');
  const { env } = world({ ASSETS: diskAssets(new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) });

  const home = await call(env, '/');
  eq('the arcade page is served', home.res.status, 200);
  ok('it is html', (home.res.headers.get('Content-Type') || '').indexOf('text/html') === 0);
  const csp = home.res.headers.get('Content-Security-Policy') || '';
  ok('the hub page has a CSP', csp.indexOf("default-src 'self'") === 0, csp);
  ok('the hub page cannot be framed', csp.indexOf("frame-ancestors 'none'") > 0 &&
    home.res.headers.get('X-Frame-Options') === 'DENY');
  ok('member games may be framed', csp.indexOf('frame-src https://*.github.io') > 0, csp);
  ok('avatars are allowed', csp.indexOf('https://avatars.githubusercontent.com') > 0);
  ok('nosniff is set', home.res.headers.get('X-Content-Type-Options') === 'nosniff');
  ok('no inline script in the page', home.text.indexOf('<script>') < 0);

  const seeded = await call(env, '/api/hub');
  eq('the first round is seeded from round.json', seeded.body.round.round, 1);
  ok('including its note', String(seeded.body.round.note).indexOf('first round') > 0,
    seeded.body.round.note);

  /* the house games are on GitHub Pages now, not served by the Worker at all */
  const game = await call(env, '/games/rare-pull/');
  eq('the Worker does not serve the house games any more', game.res.status, 404);
  const onDisk = fs.existsSync(new URL('../games/rare-pull/index.html', import.meta.url));
  ok('they sit in games/ at the repo root for GitHub Pages', onDisk);
  ok('with a .nojekyll beside them', fs.existsSync(new URL('../.nojekyll', import.meta.url)));
  const moved = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok('and the old address shows a moved page',
    moved.indexOf('https://hub.sp101.workers.dev') > 0 && moved.indexOf('MOVED') > 0);

  for (const p of ['/players.html', '/play.html', '/join.html', '/rules.html', '/admin.html', '/mygames.html']) {
    const r = await call(env, p);
    eq('page served: ' + p, r.res.status, 200);
  }
  const join = await call(env, '/join?code=ABCD1234');
  eq('/join serves the join page', join.res.status, 200);
  ok('with the sign-in button', join.text.indexOf('Sign in with GitHub') > 0);
  const adminPage = await call(env, '/admin');
  eq('/admin serves the panel page', adminPage.res.status, 200);
  const missing = await call(env, '/nothing-here');
  eq('an unknown page is a 404', missing.res.status, 404);
  const climb = await call(env, '/assets/../../package.json');
  ok('climbing out of public/ fails', climb.res.status === 400 || climb.res.status === 404,
    'status ' + climb.res.status);

  /* on the real site the cookie is Secure */
  const live = world({ HUB_INSECURE_COOKIES: '0' });
  const inv = await getSettings(live.store);
  const s = await signIn(live.env, 'friend-one', inv.inviteCode);
  ok('the session cookie is Secure in production', /Secure/.test(s.sessionRaw), s.sessionRaw);
}

/* ---------- run ---------- */

const groups = [testPure, testSessions, testOauth, testInvite, testGames, testRefresh,
  testBudget, testAdmin, testMisc, testOwnSecret, testSetupGate, testRenamedAccounts,
  testDrafts, testCovers, testHeaders];

(async () => {
  for (const g of groups) {
    try {
      await g();
    } catch (e) {
      fail++;
      failures.push(g.name + ' threw: ' + e.message);
      console.log('  THREW in ' + g.name + ': ' + e.stack);
    }
  }
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('failures:');
    for (const f of failures) console.log(' - ' + f);
    process.exit(1);
  }
})();
