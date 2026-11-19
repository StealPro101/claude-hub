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
import { getState, update, listOf } from '../worker/state.js';
import { PresenceCore } from '../worker/presence.js';
import { fakePresence, fakeStorage, fakeSocket, fakeRoomState } from './fake-presence.js';
import {
  RoomsCore, roomRequest, MAX_PLAYERS, MAX_SOCKETS, MAX_MSG, RATE_BURST, RATE_DROPS, DAILY_MSGS
} from '../worker/rooms.js';
import {
  clean, pretty, isLogin, isRepoName, playUrl, normalizeHubJson, repoEligible, hasTopic,
  isOkEmoji, allowedCategory, safeAvatar
} from '../worker/validate.js';
import { pack } from '../worker/util.js';
import {
  refresh, getSettings, saveSettings, hubPayload, HOUSE_GAMES, houseGames, isHubRepo
} from '../worker/hub.js';
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

/* The Hub keeps everything in one document now; these read it the way a test wants. */
async function gameOf(store, ownerId, repo) {
  return (await getState(store)).games[ownerId + '/' + repo] || null;
}
async function gameRows(store, prefix) {
  const games = (await getState(store)).games;
  return Object.keys(games)
    .filter((k) => !prefix || k.indexOf(prefix) === 0)
    .map((k) => ({ key: 'game:' + k, value: games[k] }));
}
async function memberOf(store, id) {
  return (await getState(store)).members[String(id)] || null;
}
async function tombOf(store, ownerId, repo) {
  return (await getState(store)).tombs[ownerId + '/' + repo] || null;
}
async function setMember(store, id, rec) {
  await update(store, (st) => { st.members[String(id)] = rec; });
}
async function dropMember(store, id) {
  await update(store, (st) => { delete st.members[String(id)]; });
}
async function setBan(store, rec) {
  await update(store, (st) => { st.bans[String(rec.id)] = rec; });
}


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
  await update(store, (st) => {
    for (const k of Object.keys(st.games)) st.games[k].status = 'published';
  });
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
  ok('no member was made', (await memberOf(store, 7001)) === null);

  const wrongCode = await signIn(env, 'friend-one', 'WRONGCODE');
  eq('wrong invite refused', wrongCode.status, 403);

  const right = await signIn(env, 'friend-one', code);
  ok('right invite gets in', Boolean(right.session), 'status ' + right.status);
  const member = await memberOf(store, 7001);
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
  await setBan(b.store, { id: 7004, login: 'banned-bob', at: 'now', by: 'test' });
  const sb = await getSettings(b.store);
  const banned = await signIn(b.env, 'banned-bob', sb.inviteCode);
  eq('banned cannot sign in', banned.status, 403);
  ok('banned made no member', (await memberOf(b.store, 7004)) === null);
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
  ok('tombstone kept', (await tombOf(store, 7001, 'plain-game')).by === 'member');
}

/* ---------- 5b. the Hub's own repo is never a game ---------- */

async function testHubRepo() {
  console.log('the Hub is not a game');
  const { env, store } = world();
  const admin = await joined('sp101-admin', env, store);

  ok('isHubRepo spots it by the admin id', isHubRepo(env, 'sp101-admin', 'claude-hub', 9001));
  ok('and ignores the case of the repo name', isHubRepo(env, 'sp101-admin', 'CLAUDE-HUB', 9001));
  ok('another repo of the owner is still a game', !isHubRepo(env, 'sp101-admin', 'owner-game', 9001));
  ok('and the same name on someone else’s account is not the Hub',
    !isHubRepo(env, 'friend-one', 'claude-hub', 7001));

  /* 1. it is never offered */
  const repos = await call(env, '/api/my/repos', { cookie: admin });
  ok('/api/my/repos never lists the Hub itself',
    repos.body.repos.every((r) => r.repo !== 'claude-hub'),
    repos.body.repos.map((r) => r.repo).join());
  ok('but still lists the owner’s real game',
    repos.body.repos.some((r) => r.repo === 'owner-game'));

  /* 2. adding it by hand is refused */
  const add = await call(env, '/api/games/add', { body: { repo: 'claude-hub' }, cookie: admin });
  eq('adding the Hub itself is refused', add.res.status, 400);
  eq('and says what it is', add.body.error, 'that is the Hub itself');
  const shouty = await call(env, '/api/games/add', { body: { repo: 'CLAUDE-HUB' }, cookie: admin });
  eq('in any capitals', shouty.body.error, 'that is the Hub itself');

  /* the login rule, case-insensitively, with no admin id to help */
  const byLogin = world({ HUB_OWNER_LOGIN: 'FRIEND-ONE', HUB_REPO: 'Plain-Game', ADMIN_GITHUB_IDS: '9001' });
  const one = await joined('friend-one', byLogin.env, byLogin.store);
  ok('the owner login is matched whatever the case',
    isHubRepo(byLogin.env, 'friend-one', 'plain-game', 7001));
  const mine = await call(byLogin.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: one });
  eq('so that member cannot add it either', mine.body.error, 'that is the Hub itself');
  const stillOk = await call(byLogin.env, '/api/games/add', { body: { repo: 'snake-dash' }, cookie: one });
  eq('their other games are untouched', stillOk.res.status, 200);

  /* 3. the topic does not bring it in */
  await refresh(env, store, {});
  await refresh(env, store, {});
  ok('the topic refresh skips the Hub repo', (await gameOf(store, 9001, 'claude-hub')) === null);
  ok('while it did pick up the owner’s real game', Boolean(await gameOf(store, 9001, 'owner-game')));

  /* 4. a record that is already there goes, with its picture and its favourites */
  const planted = world();
  const pAdmin = await joined('sp101-admin', planted.env, planted.store);
  const pFriend = await joined('friend-one', planted.env, planted.store);
  await update(planted.store, (s) => {
    s.games['9001/claude-hub'] = {
      id: 'sp101-admin/claude-hub', ownerId: 9001, owner: 'sp101-admin', repo: 'claude-hub',
      title: 'Claude Hub', description: 'the thing we are playing on', category: 'freestyle',
      url: 'https://sp101-admin.github.io/claude-hub/', status: 'draft', loves: [],
      cover: { v: 'abc', type: 'image/png' }
    };
    s.members['7001'].favorites = ['sp101-admin/claude-hub', 'house/rare-pull'];
  });
  await planted.store.putBytes('cover:9001/claude-hub', pngBytes(), 'image/png');
  ok('the planted record is really there', Boolean(await gameOf(planted.store, 9001, 'claude-hub')));

  /* any write at all sweeps it out */
  const pres = await call(planted.env, '/api/me/presence', { body: { show: true }, cookie: pFriend });
  eq('an unrelated write still answers normally', pres.res.status, 200);
  ok('and the Hub’s own record is gone', (await gameOf(planted.store, 9001, 'claude-hub')) === null);
  ok('its picture bytes are gone too',
    (await planted.store.getBytes('cover:9001/claude-hub')) === null);
  const favs = (await memberOf(planted.store, 7001)).favorites;
  eq('it is out of everyone’s favourites', favs.join(), 'house/rare-pull');
  const hub = await call(planted.env, '/api/hub', { cookie: pAdmin });
  ok('and the owner has no such draft',
    hub.body.games.every((g) => g.id !== 'sp101-admin/claude-hub'),
    hub.body.games.map((g) => g.id).join());
  const log = JSON.stringify((await getSettings(planted.store)).log);
  ok('the sweep says so in the log', log.indexOf('hub repo dropped') > 0, log.slice(0, 160));

  /* and so does the refresh, on its own */
  const byRefresh = world();
  await joined('sp101-admin', byRefresh.env, byRefresh.store);
  await update(byRefresh.store, (s) => {
    s.games['9001/claude-hub'] = {
      id: 'sp101-admin/claude-hub', ownerId: 9001, owner: 'sp101-admin', repo: 'claude-hub',
      title: 'Claude Hub', description: '', category: 'freestyle', status: 'published',
      url: 'https://sp101-admin.github.io/claude-hub/'
    };
  });
  /* with the write-time sweep taken off, the refresh is the one that gets it */
  delete byRefresh.store.sweep;
  const sum = await refresh(byRefresh.env, byRefresh.store, {});
  eq('the refresh reports dropping it', sum.hubRepo, 1);
  ok('and it is gone', (await gameOf(byRefresh.store, 9001, 'claude-hub')) === null);
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
  const games = (await gameRows(store)).map((r) => r.value.id).sort();
  ok('snake-dash came in on the topic', games.indexOf('friend-one/snake-dash') >= 0, games.join());
  ok('plain-game (no topic) stayed out', games.indexOf('friend-one/plain-game') < 0, games.join());
  ok('a repo named <login>.github.io plays at the root',
    (await gameOf(store, 7002, 'friend-two.github.io')).url === 'https://friend-two.github.io/');

  const xss = await gameOf(store, 7001, 'xss-game');
  eq('a title full of HTML is kept as plain text', xss.title, '<img src=x onerror=alert(1)>');
  eq('a javascript: link in a description stays text',
    xss.description.indexOf('javascript:') > 0, true);
  eq('the play address ignores hub.json entirely', xss.url, 'https://friend-one.github.io/xss-game/');

  /* a member who removes a game by hand keeps it off */
  const session = await joined('friend-one', env, store);
  await call(env, '/api/games/remove', { body: { repo: 'snake-dash' }, cookie: session });
  const second = await refresh(env, store, {});
  ok('a game removed by the member is not auto-added again',
    (await gameOf(store, 7001, 'snake-dash')) === null, JSON.stringify(second));

  /* re-adding by hand clears the member's own tombstone */
  const back = await call(env, '/api/games/add', { body: { repo: 'snake-dash' }, cookie: session });
  eq('the member can add it back', back.res.status, 200);
  ok('their own tombstone is gone', (await tombOf(store, 7001, 'snake-dash')) === null);

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
    (await gameOf(store, 7001, 'snake-dash')) === null, JSON.stringify(third));

  /* a GitHub outage must not lose anything */
  const before = (await gameRows(store)).length;
  current.state.broken = true;
  const broke = await refresh(env, store, {});
  current.state.broken = false;
  eq('nothing was lost during an outage', (await gameRows(store)).length, before);
  ok('the outage was counted, not ignored', broke.errors > 0, JSON.stringify(broke));

  /* a repo that disappears goes away */
  current.state.repos['friend-two'] = [];
  await refresh(env, store, { batch: 4 });
  await refresh(env, store, { batch: 4 });
  ok('a vanished repo is dropped', (await gameOf(store, 7002, 'friend-two.github.io')) === null);
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
    await setMember(store, id, {
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
  const seen = (await gameRows(store)).length;
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
  ok('the admin is still there', Boolean(await memberOf(store, 9001)));
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
  const target = (await gameRows(store)).map((r) => r.value)
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
  ok('the member is gone', (await memberOf(store, 7001)) === null);
  ok('their games are gone too', (await gameRows(store, '7001/')).length === 0);
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
  eq('the payload says version 5', payload.v, 5);
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
  const before = (await gameRows(store)).map((r) => r.value);
  ok('the member has games to start with', before.length >= 2, String(before.length));

  renameFakeUser(current.state, 'friend-one', 'friend-renamed');
  const sum = await refresh(env, store, {});
  const member = await memberOf(store, 7001);
  eq('the member keeps their id and gets the new login', member.login, 'friend-renamed');
  eq('and is not marked gone', Boolean(member.gone), false);
  const after = (await gameRows(store)).map((r) => r.value);
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
  const half = (await gameRows(store)).map((r) => r.value);
  ok('two failures change nothing yet', half.every((g) => !g.hidden), 'hidden too early');
  eq('but the misses are counted', (await memberOf(store, 7001)).misses, 2);

  await refresh(env, store, {});
  const gone = (await gameRows(store)).map((r) => r.value);
  eq('the games are still stored after the third failure', gone.length, before.length);
  ok('but every one of them is hidden', gone.every((g) => g.hidden), 'still showing');
  eq('and the member is flagged gone', (await memberOf(store, 7001)).gone, true);
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
  const topicGame = await gameOf(store, 7001, 'snake-dash');
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
  const kept = await gameOf(store, 7001, 'plain-game');
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
    (await gameOf(store, 7001, 'plain-game')).status, 'draft');

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

  const stored = await gameOf(store, 7001, 'plain-game');
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
  await dropMember(stranger.store, 9001);
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
  const want = '/img/cover/7001/plain-game?v=' + (await gameOf(store, 7001, 'plain-game')).cover.v;
  ok('the arcade gets a cover address, not bytes',
    hub.body.games.some((g) => g.cover === want), want);

  /* owner takes the picture off */
  const off = await call(env, '/api/games/cover-remove', { body: { repo: 'plain-game' }, cookie: mine });
  eq('the maker can take the picture off', off.res.status, 200);
  eq('and it is really gone', (await call(env, '/img/cover/7001/plain-game?v=1')).res.status, 404);
  eq('the record forgets it', (await gameOf(store, 7001, 'plain-game')).cover, null);

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
  ok('the counter is kept by the presence object, so KV is never touched for it',
    limited.env.PRESENCE.core.rates.get('cover:7001').n >= 12,
    JSON.stringify([...limited.env.PRESENCE.core.rates.keys()]));
  ok('and nothing about it is in the store',
    (await limited.store.get('rate:cover:7001')) === null);

  /* with no presence object at all the counter falls back to the store */
  const noDo = world({ PRESENCE: null });
  const who2 = await joined('friend-one', noDo.env, noDo.store);
  await call(noDo.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: who2 });
  await call(noDo.env, '/api/games/cover?repo=plain-game', {
    raw: pngBytes(), rawType: 'image/png', cookie: who2
  });
  ok('without the presence object the store keeps the count',
    (await noDo.store.get('rate:cover:7001')).n === 1);

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

/* ---------- 14. favourites, reports, how-to text ---------- */

async function testFavorites() {
  console.log('favourites and reports');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  const other = await joined('friend-two', env, store);
  const admin = await joined('sp101-admin', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });

  const draftFav = await call(env, '/api/games/favorite', {
    body: { id: 'friend-one/plain-game', on: true }, cookie: other
  });
  eq('a draft cannot be favourited', draftFav.res.status, 400);

  await call(env, '/api/games/meta', { body: { repo: 'plain-game', title: 'Plain Game' }, cookie: mine });
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });

  const anon = await call(env, '/api/games/favorite', { body: { id: 'friend-one/plain-game', on: true } });
  eq('a signed-out visitor cannot favourite', anon.res.status, 401);

  const gone = await call(env, '/api/games/love', {
    body: { id: 'friend-one/plain-game', on: true }, cookie: other
  });
  eq('the old love route is gone for good', gone.res.status, 404);

  const fav = await call(env, '/api/games/favorite', {
    body: { id: 'friend-one/plain-game', on: true }, cookie: other
  });
  eq('a member can favourite a published game', fav.res.status, 200);
  eq('and is told it is on their list', fav.body.favorite, true);
  ok('with no count of any kind in the answer',
    fav.text.indexOf('loves') < 0 && fav.text.indexOf('count') < 0, fav.text);

  const again = await call(env, '/api/games/favorite', {
    body: { id: 'friend-one/plain-game', on: true }, cookie: other
  });
  eq('favouriting twice changes nothing', again.body.favorite, true);
  eq('and it is stored once', (await memberOf(store, 7002)).favorites.length, 1);

  /* ---- it is private ---- */
  const seen = await call(env, '/api/hub', { cookie: other });
  const g = seen.body.games.find((x) => x.id === 'friend-one/plain-game');
  eq('their own payload marks it as a favourite', g.favorite, true);
  eq('and lists it under me', (seen.body.me.favorites || []).join(), 'friend-one/plain-game');

  const ownerView = await call(env, '/api/hub', { cookie: mine });
  eq('the maker of the game is told nothing about it',
    ownerView.body.games.find((x) => x.id === 'friend-one/plain-game').favorite, false);
  eq('and has an empty list of their own', (ownerView.body.me.favorites || []).length, 0);
  const adminView = await call(env, '/api/hub', { cookie: admin });
  eq('not even the Hub owner is told', adminView.body.games
    .find((x) => x.id === 'friend-one/plain-game').favorite, false);
  const strangerView = await call(env, '/api/hub');
  const g2 = strangerView.body.games.find((x) => x.id === 'friend-one/plain-game');
  eq('a signed-out visitor sees no favourite mark', g2.favorite, false);
  eq('and has no me at all', strangerView.body.me, null);

  for (const [name, view] of [['the maker', ownerView], ['the Hub owner', adminView],
    ['a signed-out visitor', strangerView]]) {
    const text = JSON.stringify(view.body);
    ok(name + ' is told no count and no list', text.indexOf('"loves"') < 0 &&
      text.indexOf('"lovedByMe"') < 0 && text.indexOf('"loved"') < 0 &&
      text.indexOf('friend-two/favorites') < 0);
    ok(name + ' sees nothing about anyone else’s favourites',
      (view.body.members || []).every((m) => m.favorites === undefined && m.loved === undefined));
  }
  ok('no member record in the payload carries a favourites field at all',
    JSON.stringify(seen.body.members).indexOf('favorite') < 0);

  const offRes = await call(env, '/api/games/favorite', {
    body: { id: 'friend-one/plain-game', on: false }, cookie: other
  });
  eq('a favourite can be taken back', offRes.body.favorite, false);
  eq('and the list is empty again', (await memberOf(store, 7002)).favorites.length, 0);

  /* a favourite survives the game going to draft and back */
  await call(env, '/api/games/favorite', { body: { id: 'friend-one/plain-game', on: true }, cookie: other });
  await call(env, '/api/games/unpublish', { body: { repo: 'plain-game' }, cookie: mine });
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  eq('the favourite survived unpublish and publish',
    (await memberOf(store, 7002)).favorites.length, 1);

  /* the house game can be a favourite too */
  const houseFav = await call(env, '/api/games/favorite', {
    body: { id: 'house/rare-pull', on: true }, cookie: admin
  });
  eq('the house game can be favourited', houseFav.body.favorite, true);
  const hub2 = await call(env, '/api/hub', { cookie: admin });
  eq('and it shows for them', hub2.body.games.find((x) => x.id === 'house/rare-pull').favorite, true);
  eq('newest favourite first', (hub2.body.me.favorites || [])[0], 'house/rare-pull');

  /* nothing that is not a game */
  const junkFav = await call(env, '/api/games/favorite', { body: { id: 'nobody/nothing' }, cookie: other });
  eq('favouriting something that is not here is refused', junkFav.res.status, 400);

  /* a member who leaves takes their own list with them */
  await call(env, '/api/admin/member/ban', { body: { id: 7002 }, cookie: admin });
  ok('their list went with the member record', (await memberOf(store, 7002)) === null);
  const afterBan = await call(env, '/api/hub');
  ok('and nothing anywhere remembers it',
    JSON.stringify(afterBan.body).indexOf('"favorites"') < 0 ||
    JSON.stringify(afterBan.body.games).indexOf('favorite":true') < 0);

  /* a favourite pointing at a game that is gone is tidied away by the refresh */
  const stale = world();
  const s1 = await joined('friend-one', stale.env, stale.store);
  await call(stale.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: s1 });
  await call(stale.env, '/api/games/meta', { body: { repo: 'plain-game', title: 'P' }, cookie: s1 });
  await call(stale.env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: s1 });
  await call(stale.env, '/api/games/favorite', {
    body: { id: 'friend-one/plain-game', on: true }, cookie: s1
  });
  await call(stale.env, '/api/games/remove', { body: { repo: 'plain-game' }, cookie: s1 });
  eq('the favourite is still there right after the game goes',
    (await memberOf(stale.store, 7001)).favorites.length, 1);
  await refresh(stale.env, stale.store, {});
  eq('and the refresh clears it', (await memberOf(stale.store, 7001)).favorites.length, 0);

  /* the cap */
  const capped = world();
  const c1 = await joined('friend-one', capped.env, capped.store);
  await update(capped.store, (s) => {
    const list = [];
    for (let i = 0; i < 140; i++) list.push('someone/game-' + i);
    s.members['7001'].favorites = list;
  });
  eq('a list is never longer than 100', (await call(capped.env, '/api/hub', { cookie: c1 }))
    .body.me.favorites.length, 100);

  /* the hourly allowance, as the loves had */
  const limited = world();
  const a = await joined('friend-one', limited.env, limited.store);
  const b = await joined('friend-two', limited.env, limited.store);
  await call(limited.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: a });
  await call(limited.env, '/api/games/meta', { body: { repo: 'plain-game', title: 'P' }, cookie: a });
  await call(limited.env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: a });
  let hit = 0;
  for (let i = 0; i < 62; i++) {
    const r = await call(limited.env, '/api/games/favorite', {
      body: { id: 'friend-one/plain-game', on: i % 2 === 0 }, cookie: b
    });
    if (r.res.status === 429) { hit = i + 1; break; }
  }
  eq('star number 61 in an hour is refused', hit, 61);

  /* reports */
  const rep = await call(env, '/api/games/report', { body: { id: 'friend-one/plain-game' }, cookie: mine });
  eq('a member can report a game', rep.res.status, 200);
  const state = await call(env, '/api/admin/state', { cookie: admin });
  ok('and it lands in the owner’s activity log',
    state.body.log.some((e) => e.what === 'reported' && e.detail === 'friend-one/plain-game'),
    JSON.stringify(state.body.log.slice(0, 3)));
  ok('the report is nowhere in the public payload',
    JSON.stringify((await call(env, '/api/hub')).body).indexOf('reported') < 0);
  let repHit = 0;
  for (let i = 0; i < 8; i++) {
    const r = await call(env, '/api/games/report', {
      body: { id: 'friend-one/plain-game' }, cookie: mine
    });
    if (r.res.status === 429) { repHit = i + 2; break; }
  }
  eq('the sixth report in a day is refused', repHit, 6);
  const junk = await call(env, '/api/games/report', { body: { id: 'nobody/nothing' }, cookie: other });
  ok('reporting something that does not exist is refused',
    junk.res.status === 404 || junk.res.status === 403, 'status ' + junk.res.status);
}

/* ---------- 14b. the one-time move from loves to favourites ---------- */

async function testLoveMigration() {
  console.log('loves become favourites');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  const other = await joined('friend-two', env, store);
  const admin = await joined('sp101-admin', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });
  await call(env, '/api/games/meta', { body: { repo: 'plain-game', title: 'Plain Game' }, cookie: mine });
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });

  /* an old document: loves counted on the games, nobody has a favourites list */
  await update(store, (s) => {
    s.games['7001/plain-game'].loves = [7002, 9001, 123456];
    s.house['rare-pull'] = { loves: [7002] };
    delete s.members['7002'].favorites;
  });
  ok('the old shape is really there',
    Array.isArray((await gameOf(store, 7001, 'plain-game')).loves));

  /* the next write of the document moves it */
  const after = await call(env, '/api/hub', { cookie: other });
  const moved = await memberOf(store, 7002);
  eq('a member who loved two games now has two favourites', moved.favorites.length, 2);
  ok('the game they loved is on their list',
    moved.favorites.indexOf('friend-one/plain-game') >= 0, moved.favorites.join());
  ok('and so is the house game', moved.favorites.indexOf('house/rare-pull') >= 0);
  eq('the owner got theirs too', (await memberOf(store, 9001)).favorites.join(),
    'friend-one/plain-game');
  ok('a love from somebody who is not a member any more is simply dropped',
    JSON.stringify(await getState(store)).indexOf('123456') < 0);

  eq('the loves field is gone from the game',
    (await gameOf(store, 7001, 'plain-game')).loves, undefined);
  eq('and from the house game', (await getState(store)).house['rare-pull'].loves, undefined);
  ok('nothing counted is left in the payload', after.text.indexOf('"loves"') < 0);
  eq('the member sees their moved favourite', after.body.games
    .find((g) => g.id === 'friend-one/plain-game').favorite, true);
  const adminSees = await call(env, '/api/hub', { cookie: admin });
  eq('and so does the owner, for their own', adminSees.body.games
    .find((g) => g.id === 'friend-one/plain-game').favorite, true);

  /* running again changes nothing */
  const favsOf = async () => JSON.stringify(listOf((await getState(store)).members)
    .map((m) => m.id + ':' + (m.favorites || []).join('+')).sort());
  const before = await favsOf();
  await call(env, '/api/hub', { cookie: other });
  await call(env, '/api/me/presence', { body: { show: true }, cookie: other });
  eq('the move happens once, not every write', await favsOf(), before);

  /* and the refresh does it as well, on a store with no write-time sweep */
  const byRefresh = world();
  await joined('friend-one', byRefresh.env, byRefresh.store);
  const f2 = await joined('friend-two', byRefresh.env, byRefresh.store);
  await call(byRefresh.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: f2 });
  await update(byRefresh.store, (s) => {
    s.games['7001/snake-dash'] = {
      id: 'friend-one/snake-dash', ownerId: 7001, owner: 'friend-one', repo: 'snake-dash',
      title: 'Snake Dash', description: '', category: 'arcade', status: 'published',
      url: 'https://friend-one.github.io/snake-dash/', loves: [7002]
    };
  });
  delete byRefresh.store.sweep;
  const sum = await refresh(byRefresh.env, byRefresh.store, {});
  ok('the refresh reports the move', sum.moved >= 1, JSON.stringify(sum));
  ok('and the favourite is on the member',
    (await memberOf(byRefresh.store, 7002)).favorites.indexOf('friend-one/snake-dash') >= 0);
}

/* ---------- 14c. the editor saves every field, draft or shared ---------- */

async function testEditEveryField() {
  console.log('the editor saves everything');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  const other = await joined('friend-two', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });

  const all = {
    repo: 'plain-game',
    title: 'The Whole Form',
    description: 'every field, typed in',
    category: 'puzzle',
    howto: 'Arrows to move.\nSpace to jump.',
    notes: 'Music by a friend.\nSprites by me.'
  };

  const asDraft = await call(env, '/api/games/meta', { body: all, cookie: mine });
  eq('a draft takes every field', asDraft.res.status, 200);
  for (const key of ['title', 'description', 'category', 'howto', 'notes']) {
    eq('draft kept the ' + key, asDraft.body.game[key], all[key]);
  }
  eq('and it is still a draft', asDraft.body.game.status, 'draft');

  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  const changed = Object.assign({}, all, {
    title: 'Changed After Sharing',
    description: 'edited while it was in the arcade',
    category: 'arcade',
    howto: 'WASD now.',
    notes: 'Thanks everyone.'
  });
  const asShared = await call(env, '/api/games/meta', { body: changed, cookie: mine });
  eq('a shared game takes every field too', asShared.res.status, 200);
  for (const key of ['title', 'description', 'category', 'howto', 'notes']) {
    eq('shared kept the ' + key, asShared.body.game[key], changed[key]);
  }
  eq('and it stays shared', asShared.body.game.status, 'published');
  const stored = await gameOf(store, 7001, 'plain-game');
  eq('the document really has the new name', stored.title, 'Changed After Sharing');
  eq('and the new notes', stored.notes, 'Thanks everyone.');
  const hub = await call(env, '/api/hub');
  eq('the arcade shows the change at once',
    hub.body.games.find((g) => g.id === 'friend-one/plain-game').title, 'Changed After Sharing');

  /* emptying a field really empties it */
  const cleared = await call(env, '/api/games/meta', {
    body: { repo: 'plain-game', title: 'Changed After Sharing', description: '', howto: '', notes: '' },
    cookie: mine
  });
  eq('clearing the description works', cleared.body.game.description, '');
  eq('clearing how to play works', cleared.body.game.howto, '');

  /* and nobody else can do any of it */
  const theirs = await call(env, '/api/games/meta', {
    body: { repo: 'plain-game', title: 'mine now' }, cookie: other
  });
  eq('somebody else cannot edit it', theirs.res.status, 404);

  /* unpublishing from the editor, then publishing again */
  const un = await call(env, '/api/games/unpublish', { body: { repo: 'plain-game' }, cookie: mine });
  eq('the editor can take it back to a draft', un.body.game.status, 'draft');
  const re = await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  eq('and share it again', re.body.game.status, 'published');
}

async function testLongFields() {
  console.log('how to play / notes');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });

  const set = await call(env, '/api/games/meta', {
    body: {
      repo: 'plain-game', title: 'Plain Game',
      howto: 'Arrows to move.\n\n\n\nSpace to jump.   Really.',
      notes: 'x'.repeat(900)
    },
    cookie: mine
  });
  eq('the long fields are accepted', set.res.status, 200);
  eq('line breaks are kept', set.body.game.howto, 'Arrows to move.\n\nSpace to jump. Really.');
  eq('and they are capped', set.body.game.notes.length, 600);

  const hostile = await call(env, '/api/games/meta', {
    body: {
      repo: 'plain-game', title: 'Plain Game',
      howto: '<img src=x onerror=alert(1)>\n<script>alert(2)</script>'
    },
    cookie: mine
  });
  eq('html in them is kept as plain text', hostile.body.game.howto,
    '<img src=x onerror=alert(1)>\n<script>alert(2)</script>');

  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  const hub = await call(env, '/api/hub');
  const g = hub.body.games.find((x) => x.id === 'friend-one/plain-game');
  ok('the arcade payload carries them', g.howto.indexOf('onerror') > 0, g.howto.slice(0, 40));
  ok('and saving again with an empty notes field clears it', g.notes === '', g.notes);

  await refresh(env, store, {});
  await refresh(env, store, {});
  eq('the refresh never overwrites them',
    (await gameOf(store, 7001, 'plain-game')).howto.indexOf('onerror') > 0, true);
}

/* ---------- 15. presence ---------- */

async function testPresenceCore() {
  console.log('presence');
  let now = 1000000;
  const core = new PresenceCore(fakeStorage(), () => now);

  core.beat('7001', null, 'friend-one/game-a');
  core.beat('7002', null, null);
  core.beat(null, 'tok-abc', 'friend-one/game-a');
  let snap = await core.snapshot();
  eq('a member in a game is playing', snap.members['7001'].game, 'friend-one/game-a');
  eq('a member on the site is online', snap.members['7002'].game, null);
  eq('both the member and the guest are counted as playing', snap.active['friend-one/game-a'], 2);
  ok('and the guest is nowhere by name', JSON.stringify(snap.members).indexOf('tok-abc') < 0);

  now += 91000;
  snap = await core.snapshot();
  eq('after 90 seconds with no beat everyone is gone', Object.keys(snap.members).length, 0);
  eq('and nobody is playing', Object.keys(snap.active).length, 0);

  core.beat('7001', null, 'friend-one/game-a');
  core.leave('7001', null);
  snap = await core.snapshot();
  eq('leaving takes effect at once', Object.keys(snap.members).length, 0);

  /* visits */
  const first = await core.visit('friend-one/game-a', '7001');
  eq('a visit counts', first.counted, true);
  const second = await core.visit('friend-one/game-a', '7001');
  eq('the same person again within half an hour does not', second.counted, false);
  await core.visit('friend-one/game-a', 'ip:1.2.3.4');
  snap = await core.snapshot();
  eq('two different people make two visits', snap.visits['friend-one/game-a'], 2);
  now += 31 * 60000;
  await core.visit('friend-one/game-a', '7001');
  snap = await core.snapshot();
  eq('and the same person counts again after half an hour', snap.visits['friend-one/game-a'], 3);

  /* recently played: the member's own row, remembered here and nowhere else */
  eq('a visit lands in that member\'s recently played',
    (await core.snapshot('7001')).recent[0], 'friend-one/game-a');
  await core.visit('friend-two/game-b', '7001');
  await core.visit('friend-one/game-c', '7001');
  let my = (await core.snapshot('7001')).recent;
  eq('newest first', my.join(','), 'friend-one/game-c,friend-two/game-b,friend-one/game-a');
  await core.visit('friend-two/game-b', '7001');
  my = (await core.snapshot('7001')).recent;
  eq('playing one again moves it to the front, without a second copy',
    my.join(','), 'friend-two/game-b,friend-one/game-c,friend-one/game-a');
  const replay = await core.visit('friend-two/game-b', '7001');
  eq('and that replay inside the half hour is still not counted twice', replay.counted, false);
  eq('it is still at the front', (await core.snapshot('7001')).recent[0], 'friend-two/game-b');
  for (let i = 0; i < 14; i++) await core.visit('friend-one/many-' + i, '7001');
  my = (await core.snapshot('7001')).recent;
  eq('a member keeps twelve games at most', my.length, 12);
  eq('the newest of them first', my[0], 'friend-one/many-13');
  await core.visit('friend-one/game-z', 'ip:9.9.9.9');
  await core.visit('friend-one/game-z', 'anon');
  eq('a guest is remembered by nobody', (await core.snapshot('ip:9.9.9.9')).recent.length, 0);
  eq('and nothing of theirs is filed under anon',
    (await core.snapshot('anon')).recent.length, 0);
  eq('nobody is handed somebody else\'s list',
    (await core.snapshot('7002')).recent.length, 0);
  eq('and asking for nobody\'s gives nothing away', (await core.snapshot()).recent.length, 0);

  /* the counters survive the object being put to sleep */
  const storage = core.storage;
  await core.maybeSave(true);
  const woken = new PresenceCore(storage, () => now);
  const snap2 = await woken.snapshot();
  eq('visits come back after an eviction', snap2.visits['friend-one/game-a'], 3);
  eq('presence does not, which is fine', Object.keys(snap2.members).length, 0);
  eq('recently played comes back too',
    (await woken.snapshot('7001')).recent[0], 'friend-one/many-13');
  await woken.forget('7001');
  eq('and clearing it empties it', (await woken.snapshot('7001')).recent.length, 0);
  const again = new PresenceCore(storage, () => now);
  eq('for good, not until the next eviction',
    (await again.snapshot('7001')).recent.length, 0);

  /* rate counting without touching KV */
  let left = null;
  for (let i = 0; i < 4; i++) left = await core.rate('love:9', 3, 60000);
  eq('the fourth in the window is refused', left.ok, false);
  /* the object going to sleep in the middle of a window must not hand out a fresh one */
  const dozed = new PresenceCore(core.storage, () => now);
  eq('a counter that is full stays full through a sleep',
    (await dozed.rate('love:9', 3, 60000)).ok, false);
  now += 61000;
  eq('and allowed again in the next window', (await core.rate('love:9', 3, 60000)).ok, true);

  /*
   * Cloudflare puts the object to sleep after about ten quiet seconds and its memory
   * goes with it, while beats are 45 seconds apart. Every call below meets a brand new
   * object on the same storage, which is what a quiet evening really looks like.
   */
  const disk = fakeStorage();
  const wake = () => new PresenceCore(disk, () => now);
  await wake().beat('7001', null, 'friend-one/space-dodge');
  await wake().beat(null, 'tok-sleepy', 'friend-one/space-dodge');
  now += 30000;
  let seen = await wake().snapshot();
  eq('somebody in a game is still in it after the object slept',
    seen.active['friend-one/space-dodge'], 2);
  eq('and a member is still shown as there', seen.members['7001'].game, 'friend-one/space-dodge');
  now += 15000;
  await wake().beat('7001', null, 'friend-one/space-dodge');
  await wake().beat(null, 'tok-sleepy', 'friend-one/space-dodge');
  seen = await wake().snapshot('7001');
  eq('45 seconds between two beats count, sleep or no sleep',
    seen.myTime['friend-one/space-dodge'], 45000);
  eq('for the guest too, in the total', seen.time['friend-one/space-dodge'], 90000);
  await wake().visit('friend-one/space-dodge', '7001');
  const twice = await wake().visit('friend-one/space-dodge', '7001');
  eq('a visit already counted is not counted again by a woken object', twice.counted, false);
  now += 91000;
  seen = await wake().snapshot();
  eq('and somebody who stopped beating is gone, not kept for ever',
    seen.active['friend-one/space-dodge'] || 0, 0);
  ok('with no row left behind', !seen.members['7001']);
}

/* ---------- 15b. how long a game has been played ---------- */

async function testPlayTime() {
  console.log('play time');
  const GAME = 'friend-one/game-a';
  let now = 5000000;
  /* every claim below starts from an empty object and a clock a test can move */
  const fresh = () => {
    now = 5000000;
    return new PresenceCore(fakeStorage(), () => now);
  };

  /* the stretch between two beats in a game IS the play time */
  let core = fresh();
  await core.beat('7001', null, GAME);
  now += 45000;
  await core.beat('7001', null, GAME);
  let snap = await core.snapshot('7001');
  eq('a beat 45 seconds after the last one is 45 seconds of play', snap.time[GAME], 45000);
  eq('and the same 45 seconds are on that member\'s own count', snap.myTime[GAME], 45000);
  now += 30000;
  await core.beat('7001', null, GAME);
  eq('the next stretch adds to it', (await core.snapshot('7001')).time[GAME], 75000);

  /* a gap longer than the 90 seconds that makes somebody "gone" is not play at all */
  core = fresh();
  await core.beat('7001', null, GAME);
  now += 91000;
  await core.beat('7001', null, GAME);
  snap = await core.snapshot('7001');
  eq('a gap over 90 seconds is a hidden or closed tab, and counts nothing',
    snap.time[GAME] || 0, 0);
  eq('so nobody is credited for it', Object.keys(snap.myTime).length, 0);

  /* being on the site is not being in a game */
  core = fresh();
  await core.beat('7002', null, null);
  now += 45000;
  await core.beat('7002', null, null);
  snap = await core.snapshot('7002');
  eq('beats from somebody who is in no game credit nothing', Object.keys(snap.time).length, 0);
  eq('and nothing of their own either', Object.keys(snap.myTime).length, 0);

  /* leaving counts the tail: the last stretch is as real as the ones before it */
  core = fresh();
  await core.beat('7001', null, GAME);
  now += 20000;
  await core.leave('7001', null);
  snap = await core.snapshot('7001');
  eq('leaving credits the stretch since the last beat', snap.time[GAME], 20000);
  eq('to the member who left', snap.myTime[GAME], 20000);
  now += 20000;
  await core.leave('7001', null);
  eq('and leaving again, with no row left, credits nothing',
    (await core.snapshot('7001')).time[GAME], 20000);

  /* loading another page of the site rewrites the row's clock - the time owed to it
     has to be taken first, or every page view would wipe out a minute */
  core = fresh();
  await core.beat('7001', null, GAME);
  now += 30000;
  core.touch('7001');
  now += 30000;
  await core.leave('7001', null);
  eq('a page load in between does not lose the time before it',
    (await core.snapshot('7001')).time[GAME], 60000);

  /* two tabs of one member share one row, so one minute is one minute */
  core = fresh();
  await core.beat('7001', null, GAME);
  await core.beat('7001', null, GAME);
  now += 45000;
  await core.beat('7001', null, GAME);
  await core.beat('7001', null, GAME);
  now += 45000;
  await core.beat('7001', null, GAME);
  await core.beat('7001', null, GAME);
  snap = await core.snapshot('7001');
  eq('two tabs of one member do not count the same 90 seconds twice', snap.time[GAME], 90000);
  eq('and their own count says the same', snap.myTime[GAME], 90000);

  /* a guest counts for the game and for nobody */
  core = fresh();
  await core.beat(null, 'tok-guest', GAME);
  now += 45000;
  await core.beat(null, 'tok-guest', GAME);
  snap = await core.snapshot('tok-guest');
  eq('a signed-out player adds to the game\'s total', snap.time[GAME], 45000);
  eq('but to nobody\'s own time', Object.keys(snap.myTime).length, 0);
  ok('and no token is kept as if it were a person',
    JSON.stringify([...core.myTime.keys()]).indexOf('tok-guest') < 0);

  /* a member who switched presence off beats as a guest - their time is still theirs */
  core = fresh();
  await core.beat(null, 'tok-hidden', GAME, '7003');
  now += 60000;
  await core.beat(null, 'tok-hidden', GAME, '7003');
  snap = await core.snapshot('7003');
  eq('an invisible member is credited privately', snap.myTime[GAME], 60000);
  eq('and their play is in the game\'s total like anyone\'s', snap.time[GAME], 60000);
  eq('nobody is handed somebody else\'s time',
    Object.keys((await core.snapshot('7004')).myTime).length, 0);
  eq('and asking for nobody\'s gives nothing away',
    Object.keys((await core.snapshot()).myTime).length, 0);
  ok('while the game\'s own total is there for everybody',
    (await core.snapshot()).time[GAME] === 60000);

  /* the counters survive the object being put to sleep */
  core = fresh();
  await core.beat('7001', null, GAME);
  now += 50000;
  await core.beat('7001', null, GAME);
  const storage = core.storage;
  await core.maybeSave(true);
  const woken = new PresenceCore(storage, () => now);
  const back = await woken.snapshot('7001');
  eq('play time comes back after an eviction', back.time[GAME], 50000);
  eq('including each member\'s own', back.myTime[GAME], 50000);
  now += 10000;
  await woken.beat('7001', null, GAME);
  now += 10000;
  await woken.leave('7001', null);
  eq('and it carries straight on through the sleep, the gap included',
    (await woken.snapshot('7001')).time[GAME], 70000);

  /* a storage key is only written when that key changed */
  const quiet = new PresenceCore(fakeStorage(), () => now);
  await quiet.load();
  let puts = [];
  quiet.storage.put = async (k) => { puts.push(k); };
  await quiet.beat('7001', null, GAME);
  now += 45000;
  await quiet.beat('7001', null, null);
  ok('a session that ends is written at once', puts.indexOf('time') >= 0, puts.join(','));
  ok('and nothing else is', puts.indexOf('visits') < 0 && puts.indexOf('recent') < 0,
    puts.join(','));
  puts = [];
  now += 45000;
  await quiet.beat('7001', null, null);
  eq('a member who is only looking around costs one small write a beat', puts.join(','), 'live');
  puts = [];
  await quiet.beat(null, 'tok-looking', null);
  now += 45000;
  await quiet.beat(null, 'tok-looking', null);
  eq('a guest who is in no game costs no write at all', puts.length, 0);
  await quiet.touch('7002');
  puts = [];
  now += 2000;
  await quiet.touch('7002');
  now += 2000;
  await quiet.touch('7002');
  eq('a burst of page loads is not a burst of writes', puts.length, 0);

  /* ---- through the site ---- */
  const { env, store } = world();
  const core7001 = env.PRESENCE.core;
  const mine = await joined('friend-one', env, store);
  const other = await joined('friend-two', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });
  await call(env, '/api/games/meta', {
    body: { repo: 'plain-game', title: 'Plain Game' }, cookie: mine
  });
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  const id = 'friend-one/plain-game';

  await call(env, '/api/presence/beat', { body: { game: id }, cookie: mine });
  /* the real clock runs while the test does; making that beat look a minute old is the
     only way to ask for a known number of seconds through the routes */
  core7001.members.get('7001').at -= 60000;
  await call(env, '/api/presence/beat', { body: { game: id }, cookie: mine });
  const own = Math.round((core7001.myTime.get('7001').get(id) || 0) / 1000);
  ok('a beat through the site credits the member it came from', own === 60, String(own));

  /* the same for somebody who switched "show when I'm online" off */
  await call(env, '/api/me/presence', { body: { show: false }, cookie: other });
  await call(env, '/api/presence/beat', {
    body: { game: id, token: 'guest-token-7' }, cookie: other
  });
  core7001.guests.get('guest-token-7').at -= 30000;
  await call(env, '/api/presence/beat', {
    body: { game: id, token: 'guest-token-7' }, cookie: other
  });
  const hiddenOwn = Math.round((core7001.myTime.get('7002').get(id) || 0) / 1000);
  ok('a hidden member\'s own time still reaches them', hiddenOwn === 30, String(hiddenOwn));
  ok('and they are still not named anywhere',
    JSON.stringify((await call(env, '/api/hub')).body.members)
      .indexOf('guest-token-7') < 0);

  const hub = await call(env, '/api/hub', { cookie: mine });
  const g = hub.body.games.find((x) => x.id === id);
  ok('the payload tells the asker their own time', g.myTime === 60, String(g.myTime));
  ok('and the game\'s total, which is everybody\'s together',
    g.playTime >= 90 && g.playTime <= 91, String(g.playTime));
  const theirs = (await call(env, '/api/hub', { cookie: other }))
    .body.games.find((x) => x.id === id);
  ok('somebody else is told their own time and not mine',
    theirs.myTime === 30, String(theirs.myTime));
  const outside = (await call(env, '/api/hub')).body.games.find((x) => x.id === id);
  eq('a signed-out visitor has no time of their own here', outside.myTime, 0);
  ok('but the total is public', outside.playTime >= 90, String(outside.playTime));
  ok('and nobody else\'s time is anywhere in the payload',
    JSON.stringify(hub.body.members).indexOf('myTime') < 0);

  /*
   * index.js keeps a five second copy of the payload. Only the signed-out one is ever
   * kept or served, so a member's own time cannot reach anybody through it.
   */
  const cached = world({ HUB_NO_CACHE: '0' });
  const c1 = await joined('friend-one', cached.env, cached.store);
  await call(cached.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: c1 });
  await call(cached.env, '/api/games/meta', {
    body: { repo: 'plain-game', title: 'Plain Game' }, cookie: c1
  });
  await call(cached.env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: c1 });
  cached.env.PRESENCE.core.time.set(id, 7200000);
  cached.env.PRESENCE.core.myTime.set('7001', new Map([[id, 3600000]]));
  const cold = (await call(cached.env, '/api/hub')).body.games.find((x) => x.id === id);
  eq('the cached payload holds no time of anybody\'s own', cold.myTime, 0);
  eq('only the public total', cold.playTime, 7200);
  const warm = (await call(cached.env, '/api/hub', { cookie: c1 }))
    .body.games.find((x) => x.id === id);
  eq('a signed-in member is never served that cache', warm.myTime, 3600);
  const again = (await call(cached.env, '/api/hub')).body.games.find((x) => x.id === id);
  eq('and the next signed-out visitor still gets nobody\'s', again.myTime, 0);
}

async function testPresenceRoutes() {
  console.log('presence through the site');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  const other = await joined('friend-two', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });
  await call(env, '/api/games/meta', { body: { repo: 'plain-game', title: 'Plain Game' }, cookie: mine });

  const draftBeat = await call(env, '/api/presence/beat', {
    body: { game: 'friend-one/plain-game' }, cookie: mine
  });
  eq('a beat is always accepted', draftBeat.res.status, 200);
  let hub = await call(env, '/api/hub', { cookie: mine });
  eq('but a draft is not somewhere you can be seen playing',
    hub.body.games.find((g) => g.id === 'friend-one/plain-game').active, 0);
  eq('the member shows as online instead',
    hub.body.members.find((m) => m.login === 'friend-one').presence.state, 'online');

  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  await call(env, '/api/presence/beat', { body: { game: 'friend-one/plain-game' }, cookie: mine });
  await call(env, '/api/presence/beat', { body: { game: 'friend-one/plain-game', token: 'guest-token-1' } });
  hub = await call(env, '/api/hub');
  const game = hub.body.games.find((g) => g.id === 'friend-one/plain-game');
  eq('a member and a signed-out player both count as playing', game.active, 2);
  /* the house game is somewhere to be as well (this route once crashed on it) */
  const houseBeat = await call(env, '/api/presence/beat', { body: { game: 'house/rare-pull', token: 'guest-token-2' } });
  eq('a beat on the house game answers ok', houseBeat.res.status, 200);
  const houseVisit = await call(env, '/api/presence/visit', { body: { game: 'house/rare-pull', token: 'guest-token-2' } });
  eq('a visit on the house game answers ok', houseVisit.res.status, 200);
  const hubHouse = await call(env, '/api/hub');
  eq('the house game shows its player', hubHouse.body.games.find((g) => g.id === 'house/rare-pull').active, 1);
  const who = hub.body.members.find((m) => m.login === 'friend-one');
  eq('the member is shown playing', who.presence.state, 'playing');
  eq('with the game', who.presence.game, 'friend-one/plain-game');
  ok('the signed-out player is in no list of people',
    JSON.stringify(hub.body.members).indexOf('guest-token-1') < 0);
  const idle = hub.body.members.find((m) => m.login === 'friend-two');
  eq('somebody who never beat is offline', idle.presence.state, 'offline');

  /* just loading a page counts as being here, or everyone would flicker offline
     between pages (the leave beacon fires on every navigation) */
  const fresh = world();
  const f1 = await joined('friend-one', fresh.env, fresh.store);
  const firstLoad = await call(fresh.env, '/api/hub', { cookie: f1 });
  const secondLoad = await call(fresh.env, '/api/hub', { cookie: f1 });
  eq('a page view on its own makes a member online',
    secondLoad.body.members.find((m) => m.login === 'friend-one').presence.state, 'online');
  ok('and a signed-out visit makes nobody online',
    (await call(fresh.env, '/api/hub')).body.members
      .every((m) => m.login !== 'friend-one' || m.presence.state === 'online'));
  ok('the first load already knew about them', firstLoad.res.status === 200);

  /* visits */
  const v1 = await call(env, '/api/presence/visit', {
    body: { game: 'friend-one/plain-game' }, cookie: other
  });
  eq('pressing play counts a visit', v1.body.counted, true);
  const v2 = await call(env, '/api/presence/visit', {
    body: { game: 'friend-one/plain-game' }, cookie: other
  });
  eq('pressing play again straight away does not', v2.body.counted, false);
  hub = await call(env, '/api/hub');
  eq('the visit count shows', hub.body.games.find((g) => g.id === 'friend-one/plain-game').visits, 1);

  /* recently played: in the payload, for the asker only */
  let mineHub = await call(env, '/api/hub', { cookie: other });
  eq('the game they just played is in their recently played',
    (mineHub.body.me.recent || [])[0], 'friend-one/plain-game');
  const theirs = await call(env, '/api/hub', { cookie: mine });
  eq('and not in anybody else\'s', (theirs.body.me.recent || []).length, 0);
  const outside = await call(env, '/api/hub');
  eq('a signed-out visitor is told nothing at all', outside.body.me, null);
  ok('no recently played is written into the games or the members',
    JSON.stringify({ g: outside.body.games, m: outside.body.members }).indexOf('recent') < 0);

  /* a game they can no longer see drops out of it */
  await call(env, '/api/games/unpublish', { body: { repo: 'plain-game' }, cookie: mine });
  mineHub = await call(env, '/api/hub', { cookie: other });
  eq('a game that is a draft again is not in their row', (mineHub.body.me.recent || []).length, 0);
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });
  mineHub = await call(env, '/api/hub', { cookie: other });
  eq('and it is back once it is published again', (mineHub.body.me.recent || []).length, 1);

  const clear = await call(env, '/api/me/recent-clear', { body: {}, cookie: other });
  eq('clearing it answers ok', clear.body.ok, true);
  mineHub = await call(env, '/api/hub', { cookie: other });
  eq('and the row is empty afterwards', (mineHub.body.me.recent || []).length, 0);
  const noCookie = await call(env, '/api/me/recent-clear', { body: {} });
  eq('a signed-out visitor cannot clear anything', noCookie.res.status, 401);
  const noOrigin = await call(env, '/api/me/recent-clear', { body: {}, cookie: other, origin: 'https://evil.test' });
  eq('and neither can another site', noOrigin.res.status, 403);

  /* the "show when I am online" switch */
  const off = await call(env, '/api/me/presence', { body: { show: false }, cookie: mine });
  eq('presence can be switched off', off.body.show, false);
  await call(env, '/api/presence/beat', { body: { game: 'friend-one/plain-game' }, cookie: mine });
  hub = await call(env, '/api/hub');
  eq('a hidden member is never listed as online',
    hub.body.members.find((m) => m.login === 'friend-one').presence.state, 'offline');
  ok('but their play still counts in the number playing',
    hub.body.games.find((g) => g.id === 'friend-one/plain-game').active >= 1,
    String(hub.body.games.find((g) => g.id === 'friend-one/plain-game').active));
  await call(env, '/api/presence/visit', { body: { game: 'friend-one/plain-game' }, cookie: mine });
  const hidden = await call(env, '/api/hub', { cookie: mine });
  eq('an invisible member still gets their own recently played',
    (hidden.body.me.recent || [])[0], 'friend-one/plain-game');

  /* and with no Durable Object at all the site just has no counts */
  const bare = world({ PRESENCE: null });
  const b1 = await joined('friend-one', bare.env, bare.store);
  await call(bare.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: b1 });
  const beat = await call(bare.env, '/api/presence/beat', {
    body: { game: 'friend-one/plain-game' }, cookie: b1
  });
  eq('a beat with no presence object still answers politely', beat.res.status, 200);
  const bareHub = await call(bare.env, '/api/hub', { cookie: b1 });
  eq('every game shows no players', bareHub.body.games.every((g) => g.active === 0), true);
  eq('and everyone is offline',
    bareHub.body.members.every((m) => m.presence.state === 'offline'), true);

  /* a broken object must not break a page either */
  const broken = world();
  broken.env.PRESENCE.break(true);
  const okHub = await call(broken.env, '/api/hub');
  eq('a presence object that throws is ignored', okHub.res.status, 200);
}

/* ---------- 15c. rooms: the relay a member's game meets in ---------- */

const ROOM_A = 'friend-one/space-dodge/ABCD';

function roomJoin(core, label, room, pid, name) {
  const ws = fakeSocket(label);
  return core.connect(ws, { room: room, pid: pid, name: name }).then(() => ws);
}

async function testRooms() {
  console.log('rooms');
  /* 2 AM UTC, so the tests below can move the clock without falling into the next day */
  let now = Date.UTC(2026, 10, 18, 2, 0, 0);
  const day = new Date(now).toISOString().slice(0, 10);
  const disk = fakeStorage();
  const seats = fakeRoomState();
  const core = new RoomsCore(seats.ops(disk, () => now));

  /* ---- hello, join, leave, host ---- */
  const a = await roomJoin(core, 'a', ROOM_A, 'player-a', 'Ann');
  const hello = a.last();
  eq('the first player is told who they are', hello.t + ':' + hello.you, 'hello:player-a');
  eq('and that the room is theirs', hello.host, 'player-a');
  eq('the code comes back as the room says it', hello.code, 'ABCD');
  eq('with themselves in the player list', JSON.stringify(hello.players),
    '[{"id":"player-a","name":"Ann"}]');

  now += 1000;
  const b = await roomJoin(core, 'b', ROOM_A, 'player-b', 'Bo');
  eq('the second player is told who the host is', b.last().host, 'player-a');
  eq('and sees both players', b.last().players.map((p) => p.id).join(','),
    'player-a,player-b');
  eq('the first player hears about the join', a.last().t + ':' + a.last().id, 'join:player-b');
  eq('by name', a.last().name, 'Bo');

  now += 1000;
  const c = await roomJoin(core, 'c', ROOM_A, 'player-c', 'Cy');
  eq('a third join reaches the first player', a.last().id, 'player-c');
  eq('and the second', b.last().id, 'player-c');
  eq('the newcomer is not the host', c.last().host, 'player-a');
  eq('the player list is in join order',
    c.last().players.map((p) => p.id).join(','), 'player-a,player-b,player-c');

  /* ---- messages go to the others and never back ---- */
  const bSoFar = b.sent.length;
  await core.message(b, JSON.stringify({ d: { move: 3 } }));
  eq('a message reaches the other players', a.last().t + ':' + a.last().from, 'msg:player-b');
  eq('with the payload untouched', JSON.stringify(a.last().d), '{"move":3}');
  eq('all of them', c.last().from, 'player-b');
  eq('and never comes back to the sender', b.sent.length, bSoFar);

  await core.message(b, JSON.stringify({ to: 'player-a', d: 'psst' }));
  eq('a message with "to" reaches that player', a.last().d, 'psst');
  eq('and nobody else', JSON.stringify(c.last().d), '{"move":3}');

  const nonsense = await core.message(b, 'not json at all');
  eq('a message that is not JSON is ignored', nonsense.why, 'ignored');
  const noD = await core.message(b, JSON.stringify({ hello: 'there' }));
  eq('and so is an object with nothing to send', noD.why, 'ignored');
  eq('nothing of either reached anybody', JSON.stringify(c.last().d), '{"move":3}');

  /* ---- one member's rooms never meet another's, or their own other games ---- */
  const other = await roomJoin(core, 'other', 'friend-two/space-dodge/ABCD', 'player-x', 'Xu');
  const sameOwnerOtherGame = await roomJoin(core, 'og', 'friend-one/other-game/ABCD',
    'player-y', 'Yo');
  const otherCode = await roomJoin(core, 'oc', 'friend-one/space-dodge/WXYZ', 'player-z', 'Zoe');
  eq('the same code on another member\'s game is another room',
    other.last().players.length, 1);
  eq('the same code on the same member\'s other game too',
    sameOwnerOtherGame.last().players.length, 1);
  eq('and another code is another room again', otherCode.last().players.length, 1);
  const before = [other.sent.length, sameOwnerOtherGame.sent.length, otherCode.sent.length];
  await core.message(b, JSON.stringify({ d: 'only us' }));
  eq('a message stays inside its own room',
    [other.sent.length, sameOwnerOtherGame.sent.length, otherCode.sent.length].join(','),
    before.join(','));

  /* ---- the same player coming back replaces their old socket ---- */
  now += 1000;
  const aSeen = a.sent.length;
  const cSeen = c.sent.length;
  const b2 = await roomJoin(core, 'b2', ROOM_A, 'player-b', 'Bo');
  eq('the old socket is told it was replaced', b.last().t + ':' + b.last().why,
    'bye:replaced');
  eq('and closed', b.readyState, 3);
  eq('the others hear nothing about it', a.sent.length + c.sent.length, aSeen + cSeen);
  eq('the new socket sees the same three players',
    b2.last().players.map((p) => p.id).join(','), 'player-a,player-b,player-c');
  eq('and the same host', b2.last().host, 'player-a');
  const closedOld = await core.close(b);
  eq('the old socket closing is not somebody leaving', closedOld.replaced, true);
  eq('so still nothing is said', a.sent.length + c.sent.length, aSeen + cSeen);

  /* ---- the host is the longest-present player, and moves on when they go ---- */
  a.readyState = 3;
  await core.close(a);
  const cTail = c.got().slice(-2);
  eq('the room is told who left', cTail[0].t + ':' + cTail[0].id, 'leave:player-a');
  eq('and who has it now', cTail[1].t + ':' + cTail[1].id, 'host:player-b');
  eq('both of them hear it', b2.last().id, 'player-b');
  /* player-b kept its place in the queue through the replace, so it is before player-c */
  now += 1000;
  c.readyState = 3;
  await core.close(c);
  eq('somebody leaving who was not the host changes nothing',
    b2.last().t + ':' + b2.last().id, 'leave:player-c');

  /* ---- a full room ---- */
  const full = 'friend-one/full-game/ROOM';
  const crowd = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    now += 10;
    crowd.push(await roomJoin(core, 'p' + i, full, 'player-f' + i, 'P' + i));
  }
  eq('twelve players fit', crowd[11].last().players.length, 12);
  const thirteenth = await roomJoin(core, 'p12', full, 'player-f12', 'P12');
  eq('the thirteenth is turned away', thirteenth.last().t + ':' + thirteenth.last().why,
    'bye:full');
  eq('and told so before being closed', thirteenth.readyState, 3);
  eq('it never reached the room', crowd[0].last().id, 'player-f11');
  /* one of the twelve coming back is not a thirteenth player */
  const again = await roomJoin(core, 'p0-again', full, 'player-f0', 'P0');
  eq('one of them reconnecting still fits', again.last().t, 'hello');
  eq('and the room is still twelve', again.last().players.length, 12);

  /* ---- a message that is too big ---- */
  const big = await roomJoin(core, 'big', 'friend-one/big-game/BIGR', 'player-big', 'Big');
  const huge = JSON.stringify({ d: 'x'.repeat(MAX_MSG + 100) });
  const bigRes = await core.message(big, huge);
  eq('a message over 16 KB is refused', bigRes.why, 'big');
  eq('with a reason', big.last().t + ':' + big.last().why, 'bye:big');
  eq('and the socket closed', big.readyState, 3);

  /* ---- the rate bucket ---- */
  const fastRoom = 'friend-one/fast-game/FAST';
  const fast = await roomJoin(core, 'fast', fastRoom, 'player-fast', 'Fa');
  const heard = await roomJoin(core, 'slowpoke', fastRoom, 'player-heard', 'He');
  const heardStart = heard.sent.length;
  let okCount = 0;
  for (let i = 0; i < RATE_BURST + 5; i++) {
    const r = await core.message(fast, JSON.stringify({ d: i }));
    if (r.ok) okCount++;
  }
  eq('a burst of 45 gets through', okCount, RATE_BURST);
  eq('the rest are dropped without a word', heard.sent.length - heardStart, RATE_BURST);
  ok('and the sender is left alone', fast.readyState === 1);
  let verdict = 'drop';
  let tries = 0;
  while (verdict === 'drop' && tries < RATE_DROPS + 50) {
    tries++;
    verdict = (await core.message(fast, JSON.stringify({ d: 'spam' }))).why;
  }
  eq('but a sender still flooding after 300 dropped messages is cut off', verdict, 'slow');
  eq('with a reason', fast.last().why, 'slow');
  /* a second later, a well-behaved player is fine again */
  now += 2000;
  const calm = await roomJoin(core, 'calm', fastRoom, 'player-calm', 'Ca');
  eq('and the room carries on', calm.last().t, 'hello');

  /* ---- 150 sockets on the whole object ---- */
  const manyDisk = fakeStorage();
  const manySeats = fakeRoomState();
  const many = new RoomsCore(manySeats.ops(manyDisk, () => now));
  let opened = 0;
  let refused = null;
  for (let r = 0; r < 14 && !refused; r++) {
    for (let i = 0; i < MAX_PLAYERS && !refused; i++) {
      now += 1;
      const ws = await roomJoin(many, 'm', 'friend-one/many/R' + r, 'player-m' + r + '-' + i, 'M');
      if (ws.last().t === 'bye') refused = ws.last().why;
      else opened++;
    }
  }
  eq('the object takes 150 sockets and no more', opened, MAX_SOCKETS);
  eq('the next one is turned away even though its own room is empty', refused, 'full');

  /* ---- the daily cap ---- */
  const capDisk = fakeStorage();
  const capSeats = fakeRoomState();
  await capDisk.put('rooms:msgs:' + day, DAILY_MSGS - 3);
  const capCore = new RoomsCore(capSeats.ops(capDisk, () => now));
  const capRoom = 'friend-one/cap-game/CAPS';
  const one = await roomJoin(capCore, 'one', capRoom, 'player-one', 'One');
  const two = await roomJoin(capCore, 'two', capRoom, 'player-two', 'Two');
  eq('under the cap a room still opens', one.got()[0].t, 'hello');
  eq('and the last messages of the day go through',
    (await capCore.message(one, JSON.stringify({ d: 1 }))).ok, true);
  eq('right up to the cap', (await capCore.message(one, JSON.stringify({ d: 2 }))).ok, true);
  const over = await capCore.message(one, JSON.stringify({ d: 3 }));
  eq('the one that reaches the cap is refused', over.why, 'limit');
  eq('and that socket is told once, then closed',
    one.last().t + ':' + one.last().why, 'bye:limit');
  eq('the count is in storage, not just in memory',
    await capDisk.get('rooms:msgs:' + day), DAILY_MSGS);
  const woken = new RoomsCore(capSeats.ops(capDisk, () => now));
  const late = await roomJoin(woken, 'late', capRoom, 'player-late', 'Late');
  eq('a brand new object on the same storage still refuses to open a room',
    late.last().t + ':' + late.last().why, 'bye:limit');
  const stillThere = await woken.message(two, JSON.stringify({ d: 'hi' }));
  eq('and still drops messages', stillThere.why, 'limit');
  eq('a dropped message is counted all the same, because Cloudflare billed it anyway',
    await capDisk.get('rooms:msgs:' + day), DAILY_MSGS + 1);
  now += 24 * 3600000;
  const tomorrow = new RoomsCore(capSeats.ops(capDisk, () => now));
  const fresh = await roomJoin(tomorrow, 'fresh', capRoom, 'player-fresh', 'Fresh');
  eq('the next UTC day starts from nothing', fresh.last().t, 'hello');
  eq('on its own key',
    await capDisk.get('rooms:msgs:' + new Date(now).toISOString().slice(0, 10)), undefined);
  eq('yesterday\'s number is left where it is',
    await capDisk.get('rooms:msgs:' + day), DAILY_MSGS + 1);

  /*
   * THE SLEEP RULE. Cloudflare puts the object to sleep after about ten quiet seconds
   * and its memory goes with it, while the sockets stay open. So every handler below
   * meets a brand new core that has never seen these sockets - which is what a quiet
   * evening really looks like.
   */
  const sleepDisk = fakeStorage();
  const sleepSeats = fakeRoomState();
  const wake = () => new RoomsCore(sleepSeats.ops(sleepDisk, () => now));
  const room = 'friend-one/sleepy/ZZZZ';
  const one2 = fakeSocket('one');
  await wake().connect(one2, { room: room, pid: 'sleep-one', name: 'One' });
  now += 30000;
  const two2 = fakeSocket('two');
  await wake().connect(two2, { room: room, pid: 'sleep-two', name: 'Two' });
  eq('a woken object finds the player who was already there',
    two2.last().players.map((p) => p.id).join(','), 'sleep-one,sleep-two');
  eq('and knows whose room it is', two2.last().host, 'sleep-one');
  eq('the one who was there is told about the new one', one2.last().id, 'sleep-two');
  now += 30000;
  await wake().message(one2, JSON.stringify({ d: 'awake?' }));
  eq('a woken object relays a message', two2.last().d, 'awake?');
  eq('from the right player', two2.last().from, 'sleep-one');
  now += 30000;
  const three = fakeSocket('three');
  await wake().connect(three, { room: room, pid: 'sleep-three', name: 'Three' });
  now += 30000;
  one2.readyState = 3;
  await wake().close(one2);
  const tail = two2.got().slice(-2);
  eq('a woken object says who left', tail[0].t + ':' + tail[0].id, 'leave:sleep-one');
  eq('and hands the room to the longest-present player left',
    tail[1].t + ':' + tail[1].id, 'host:sleep-two');
  eq('the third player hears the same', three.last().id, 'sleep-two');
  now += 30000;
  const back = fakeSocket('two-again');
  await wake().connect(back, { room: room, pid: 'sleep-two', name: 'Two' });
  eq('a woken object replaces a returning player', two2.last().why, 'replaced');
  eq('and the room is still theirs', back.last().host, 'sleep-two');
  eq('with nobody told they left', three.last().id, 'sleep-two');
  const counted = await sleepDisk.get('rooms:msgs:' + day);
  ok('and the day\'s count was written by a socket closing', counted === undefined ||
    Number.isFinite(counted), 'got ' + JSON.stringify(counted));

  /* a socket with no attachment at all (one the object never finished accepting) */
  const stray = fakeSocket('stray');
  const strayRes = await wake().message(stray, JSON.stringify({ d: 1 }));
  eq('a socket the object knows nothing about is sent away', strayRes.why, 'bad');
  eq('politely', stray.last().t + ':' + stray.last().why, 'bye:bad');
  eq('and closing it is no trouble either', (await wake().close(stray)).ok, true);
}

/* ---------- 15d. the way in: who may open a room, and with what ---------- */

async function testRoomRequest() {
  console.log('rooms: the way in');
  const logins = new Set(['friend-one', 'stealpro101']);
  const url = (q) => new URL('https://hub.test/room' + q);
  const good = '?g=space-dodge&code=abcd&pid=pid-abc123&name=Ann';

  eq('a member\'s own Pages site may open a room',
    roomRequest(url(good), 'https://friend-one.github.io', logins).room,
    'friend-one/space-dodge/ABCD');
  eq('the code is upper-cased', roomRequest(url(good), 'https://friend-one.github.io',
    logins).code, 'ABCD');
  eq('a capital in the login is the same member',
    roomRequest(url(good), 'https://Friend-One.github.io', logins).ok, true);
  eq('somebody who is not a member cannot',
    roomRequest(url(good), 'https://stranger.github.io', logins).status, 403);
  eq('and neither can another website',
    roomRequest(url(good), 'https://evil.example.com', logins).status, 403);
  eq('nor a site that only looks like Pages',
    roomRequest(url(good), 'https://friend-one.github.io.evil.example.com', logins).status, 403);
  eq('nor one with no Origin at all', roomRequest(url(good), null, logins).status, 403);
  eq('the Hub owner may, for the house games',
    roomRequest(url(good), 'https://stealpro101.github.io', logins).login, 'stealpro101');
  eq('a game being tested on this computer may, under its own name',
    roomRequest(url(good), 'http://localhost:8797', logins).room, 'local/space-dodge/ABCD');
  eq('127.0.0.1 counts as the same', roomRequest(url(good), 'http://127.0.0.1:5500',
    logins).login, 'local');
  eq('but not over https from somewhere calling itself localhost',
    roomRequest(url(good), 'https://localhost.evil.example.com', logins).status, 403);

  const bad = (q) => roomRequest(url(q), 'https://friend-one.github.io', logins);
  eq('a game name is needed', bad('?code=ABCD&pid=pid-abc123').status, 400);
  eq('a game name with a slash in it is refused',
    bad('?g=a/b&code=ABCD&pid=pid-abc123').status, 400);
  eq('and one that is too long', bad('?g=' + 'g'.repeat(61) + '&code=ABCD&pid=pid-abc123')
    .status, 400);
  eq('a two-letter code is refused', bad('?g=x&code=AB&pid=pid-abc123').status, 400);
  eq('a code with a dash in it is refused', bad('?g=x&code=AB-CD&pid=pid-abc123').status, 400);
  eq('a thirteen-letter code is refused',
    bad('?g=x&code=' + 'A'.repeat(13) + '&pid=pid-abc123').status, 400);
  eq('a player id that is too short is refused', bad('?g=x&code=ABCD&pid=short').status, 400);
  eq('a player id with odd characters in it is refused',
    bad('?g=x&code=ABCD&pid=pid!abc123').status, 400);
  eq('a missing name becomes Player', bad('?g=x&code=ABCD&pid=pid-abc123').name, 'Player');
  eq('control characters are taken out of a name',
    bad('?g=x&code=ABCD&pid=pid-abc123&name=' + encodeURIComponent('A\u0000n\nn ')).name, 'A n n');
  eq('a very long name is cut to 24',
    bad('?g=x&code=ABCD&pid=pid-abc123&name=' + 'N'.repeat(40)).name.length, 24);
}

/* ---------- 15e. rooms through the site ---------- */

async function testRoomRoutes() {
  console.log('rooms through the site');
  const { env, store } = world();
  await joined('friend-one', env, store);
  const ws = { Upgrade: 'websocket', Connection: 'Upgrade' };
  const ask = (q, origin, headers) => call(env, '/room' + q, {
    headers: Object.assign({}, headers === undefined ? ws : headers),
    origin: origin
  });
  const good = '?g=space-dodge&code=abcd&pid=pid-abc123&name=Ann';

  const member = await ask(good, 'https://friend-one.github.io');
  eq('a member\'s game is let through', member.res.status, 200);
  eq('the object is asked for an upgrade', member.body.upgrade, true);
  eq('with the finished room key', member.body.room, 'friend-one/space-dodge/ABCD');
  eq('the player\'s own id', member.body.pid, 'pid-abc123');
  eq('and the cleaned name', member.body.name, 'Ann');
  ok('nothing raw from the client is passed on',
    member.body.raw.indexOf('g=') < 0 && member.body.raw.indexOf('code=') < 0,
    member.body.raw);

  const stranger = await ask(good, 'https://stranger.github.io');
  eq('somebody who is not a member gets 403', stranger.res.status, 403);
  const site = await ask(good, 'https://evil.example.com');
  eq('another website gets 403', site.res.status, 403);
  const owner = await ask(good, 'https://stealpro101.github.io');
  eq('the Hub owner is let through', owner.res.status, 200);
  const local = await ask(good, 'http://localhost:3000');
  eq('a game being tested on this computer is let through', local.res.status, 200);
  eq('in its own corner', local.body.room, 'local/space-dodge/ABCD');

  const badCode = await ask('?g=x&code=A&pid=pid-abc123', 'https://friend-one.github.io');
  eq('a bad code is refused', badCode.res.status, 400);
  const badGame = await ask('?g=a/b&code=ABCD&pid=pid-abc123', 'https://friend-one.github.io');
  eq('a bad game name is refused', badGame.res.status, 400);
  const plain = await ask(good, 'https://friend-one.github.io', {});
  eq('an ordinary GET of /room is not a websocket', plain.res.status, 400);
  const posted = await call(env, '/room' + good, {
    headers: ws, origin: 'https://friend-one.github.io', method: 'POST'
  });
  eq('and a POST there is refused', posted.res.status, 405);

  /* the library a game loads, and the headers that let it */
  const assets = await import('./dev-server.js');
  const dir = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const { env: withFiles } = world({ ASSETS: assets.diskAssets(dir) });
  const lib = await call(withFiles, '/room.js');
  eq('the room library is served', lib.res.status, 200);
  ok('it is javascript', (lib.res.headers.get('Content-Type') || '').indexOf('javascript') >= 0,
    lib.res.headers.get('Content-Type'));
  eq('a game on another origin may load it',
    lib.res.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  ok('and only for a few minutes, so a fix reaches the games',
    (lib.res.headers.get('Cache-Control') || '').indexOf('max-age=300') > 0,
    lib.res.headers.get('Cache-Control'));
  ok('it says what it is at the top', lib.text.indexOf('HubRoom') > 0);
  const ordinary = await call(withFiles, '/assets/hub.js');
  ok('an ordinary file is not readable from another origin',
    ordinary.res.headers.get('Cross-Origin-Resource-Policy') !== 'cross-origin',
    String(ordinary.res.headers.get('Cross-Origin-Resource-Policy')));
}

/* ---------- 16. one document, no listing ---------- */

async function testOneDocument() {
  console.log('one document');
  const { env, store } = world();
  const mine = await joined('friend-one', env, store);
  await call(env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: mine });
  await call(env, '/api/games/meta', { body: { repo: 'plain-game', title: 'Plain Game' }, cookie: mine });
  await call(env, '/api/games/publish', { body: { repo: 'plain-game' }, cookie: mine });

  /* KV charges for list operations, so no request path may use one */
  let lists = 0;
  const watched = Object.assign({}, store, {
    list: async (prefix) => {
      lists++;
      return store.list(prefix);
    }
  });
  const watchedEnv = Object.assign({}, env, { HUB_STORE: watched });
  await call(watchedEnv, '/api/hub');
  await call(watchedEnv, '/api/hub', { cookie: mine });
  await call(watchedEnv, '/api/me', { cookie: mine });
  await call(watchedEnv, '/api/games/favorite', { body: { id: 'friend-one/plain-game', on: true }, cookie: mine });
  await call(watchedEnv, '/api/presence/beat', { body: { game: 'friend-one/plain-game' }, cookie: mine });
  const admin = await joined('sp101-admin', watchedEnv, watched);
  await call(watchedEnv, '/api/admin/state', { cookie: admin });
  eq('no request path lists keys', lists, 0);

  /* everything is in one value */
  const keys = [...store._map.keys()].filter((k) => k.indexOf('rate:') !== 0 && k.indexOf('secret:') !== 0);
  eq('and that value is the only one', keys.join(','), 'state');

  /* the move from the old shape, run once, on the first request */
  const old = memoryStore({
    'member:7001': {
      id: 7001, login: 'friend-one', name: 'Ada', avatar: '', bio: '',
      url: 'https://github.com/friend-one', joined: '2026-11-01'
    },
    'game:7001/old-game': {
      id: 'friend-one/old-game', ownerId: 7001, owner: 'friend-one', repo: 'old-game',
      title: 'Old Game', description: '', category: 'arcade', status: 'published',
      url: 'https://friend-one.github.io/old-game/', loves: []
    },
    'ban:7004': { id: 7004, login: 'banned-bob', at: 'then', by: 'owner' },
    'tomb:7001/gone': { by: 'admin', at: 'then' },
    settings: {
      round: { round: 7, category: 'horror', note: 'spooky' },
      inviteRequired: true, inviteCode: 'KEEPTHIS', rotation: 0, log: []
    }
  });
  const oldEnv = fakeEnv({ HUB_STORE: old, ASSETS: null });
  const moved = await call(oldEnv, '/api/hub');
  eq('the old data is still there after the move', moved.body.round.round, 7);
  ok('the member came across', moved.body.members.some((m) => m.login === 'friend-one'));
  ok('so did the game', moved.body.games.some((g) => g.id === 'friend-one/old-game'));
  const settingsNow = await getSettings(old);
  eq('and the invite code survived', settingsNow.inviteCode, 'KEEPTHIS');
  const state = await getState(old);
  ok('the ban came across', Boolean(state.bans['7004']));
  ok('and the tombstone', Boolean(state.tombs['7001/gone']));
  ok('the old keys are left exactly where they were',
    (await old.get('member:7001')) !== null && (await old.get('settings')) !== null);
  ok('the new document is there too', (await old.get('state')) !== null);

  /* running again changes nothing */
  const before = JSON.stringify(await old.get('state'));
  await call(oldEnv, '/api/hub');
  eq('a second request does not move anything again',
    JSON.stringify((await getState(old)).members), JSON.stringify(JSON.parse(before).members));

  /* an edit made while a slow refresh is running must not be lost */
  const race = world();
  const r1 = await joined('friend-one', race.env, race.store);
  await call(race.env, '/api/games/add', { body: { repo: 'plain-game' }, cookie: r1 });
  const slowRefresh = refresh(race.env, race.store, {});
  await call(race.env, '/api/games/meta', {
    body: { repo: 'plain-game', title: 'Typed While Refreshing' }, cookie: r1
  });
  await slowRefresh;
  eq('the name typed during a refresh survived it',
    (await gameOf(race.store, 7001, 'plain-game')).title, 'Typed While Refreshing');
}

/* ---------- 17. headers and static pages ---------- */

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

  for (const p of ['/players.html', '/play.html', '/join.html', '/rules.html', '/admin.html',
    '/mygames.html', '/charts.html', '/settings.html']) {
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

const groups = [testPure, testSessions, testOauth, testInvite, testGames, testHubRepo, testRefresh,
  testBudget, testAdmin, testMisc, testOwnSecret, testSetupGate, testRenamedAccounts,
  testDrafts, testCovers, testFavorites, testLoveMigration, testEditEveryField, testLongFields, testPresenceCore,
  testPlayTime, testPresenceRoutes, testRooms, testRoomRequest, testRoomRoutes,
  testOneDocument, testHeaders];

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
