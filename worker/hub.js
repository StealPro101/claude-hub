/*
 * The Hub itself: settings, members, games, loves, and the 15-minute refresh that
 * picks up games a member (or their Claude) tagged.
 *
 * Everything here reads and writes ONE document through state.js - never a list() on
 * a request path. Live counts (who is playing, visits) come from the Presence object.
 */

import {
  clean, cleanLines, pretty, isLogin, isRepoName, isId, normalizeHubJson, playUrl, repoUrl,
  safeAvatar, safeProfile, repoEligible, hasTopic, SLUG_RE, allowedCategory,
  coverKey, coverUrl, coverVersion, CATEGORIES, MAX_NAME, MAX_TITLE, MAX_DESC, MAX_LONG
} from './validate.js';
import { getState, update, noWrite, gameId as keyFor, listOf } from './state.js';
import { makeGitHub, makeBudget, BudgetError } from './github.js';
import { presenceClient } from './presence.js';
import { nowIso, today, randomCode } from './util.js';

export const DEFAULT_TOPIC = 'claude-hub-game';
export const MAX_GAMES_PER_MEMBER = 20;
export const DRAFT = 'draft';
export const PUBLISHED = 'published';
export const FAVORITES_PER_HOUR = 60;
export const MAX_FAVORITES = 100;
export const LOVES_PER_HOUR = 60;
export const REPORTS_PER_DAY = 5;
export const COVER_PER_HOUR = 12;
const REFRESH_BATCH = 4;
const META_PER_MEMBER = 6;
const LOG_KEEP = 50;
const LAST_SEEN_EVERY = 6 * 3600000;

/*
 * The Hub's own house games. They stay in games/<slug>/ in this repo, served by GitHub
 * Pages at https://<HUB_OWNER_LOGIN>.github.io/<HUB_REPO>/games/<slug>/ - exactly where
 * they have always been, so everyone's saved progress survives.
 */
export const HOUSE_GAMES = [
  {
    slug: 'rare-pull',
    title: 'Rare Pull',
    description: 'Anime trivia climb: pull cards, answer fast, duel a friend with a challenge code.',
    category: 'trivia',
    emoji: '\u{1F3B4}',
    updated: '2026-08-29T00:00:00Z'
  }
];

export function houseOwner(env) {
  const login = clean(env && env.HUB_OWNER_LOGIN, 39);
  return isLogin(login) ? login : 'StealPro101';
}

export function houseRepo(env) {
  const repo = clean(env && env.HUB_REPO, 100);
  return isRepoName(repo) ? repo : 'claude-hub';
}

export function houseGames(env) {
  if (String((env && env.HUB_HOUSE_GAMES) || '').toLowerCase() === 'off') return [];
  const owner = houseOwner(env);
  const repo = houseRepo(env);
  const base = playUrl(owner, repo);
  if (!base) return [];
  return HOUSE_GAMES.filter((g) => SLUG_RE.test(g.slug)).map((g) => ({
    id: 'house/' + g.slug,
    owner: owner,
    ownerId: null,
    title: g.title,
    description: g.description,
    howto: '',
    notes: '',
    category: g.category,
    emoji: g.emoji,
    url: base + 'games/' + g.slug + '/',
    repoUrl: repoUrl(owner, repo),
    stars: 0,
    loves: [],
    updated: g.updated,
    house: true
  }));
}

export function topicOf(env) {
  return clean(env && env.HUB_TOPIC, 50).toLowerCase() || DEFAULT_TOPIC;
}

/*
 * The repo the Hub itself lives in. It has Pages on (that is how the house games are
 * served), so left alone it turns up as something to add, and the owner ends up with
 * the Hub as a draft of his own. It is not a game and never can be: /api/my/repos
 * leaves it out, addGame refuses it, the topic never picks it up, and any record of it
 * is swept out of the document the next time anything is written.
 */
export function isHubRepo(env, login, repo, ownerId) {
  if (!isRepoName(repo)) return false;
  if (String(repo).toLowerCase() !== houseRepo(env).toLowerCase()) return false;
  const sameLogin = isLogin(login) &&
    String(login).toLowerCase() === houseOwner(env).toLowerCase();
  const sameId = ownerId != null && isId(ownerId) && isAdminId(env, ownerId);
  return sameLogin || sameId;
}

/* The keys in state.games that are really the Hub's own repo. */
export function hubRepoKeys(env, state) {
  return Object.keys(state.games).filter((k) => {
    const g = state.games[k];
    return g && isHubRepo(env, g.owner, g.repo, g.ownerId);
  });
}

/*
 * Takes the Hub's own repo out of the document: the record, its cover bytes, and the
 * place it took in anybody's favourites. Returns how many records went.
 */
export async function sweepHubRepo(env, store, state) {
  const keys = hubRepoKeys(env, state);
  if (!keys.length) return 0;
  const gone = [];
  for (const key of keys) {
    gone.push(state.games[key].id);
    delete state.games[key];
  }
  for (const id of Object.keys(state.members)) {
    const rec = state.members[id];
    const favs = favoritesOf(rec);
    const kept = favs.filter((x) => !gone.some((g) => g.toLowerCase() === x.toLowerCase()));
    if (kept.length !== favs.length) rec.favorites = kept;
  }
  logInto(state, {
    what: 'hub repo dropped', who: 'hub', detail: gone.join(', ')
  });
  if (store) {
    for (const key of keys) {
      const slash = key.indexOf('/');
      await store.delete(coverKey(key.slice(0, slash), key.slice(slash + 1)));
    }
  }
  return keys.length;
}

/* What index.js hangs on the store, so every write sweeps first. */
export function storeSweeper(env) {
  return function (state, store) {
    return sweepHubRepo(env, store, state);
  };
}

/* The same sweep on its own, for the 15-minute refresh. */
export async function purgeHubRepo(env, store) {
  const found = hubRepoKeys(env, await getState(store));
  if (!found.length) return 0;
  await update(store, async (s) => {
    await sweepHubRepo(env, store, s);
    return found.length;
  });
  return found.length;
}

export function adminIds(env) {
  return String((env && env.ADMIN_GITHUB_IDS) || '')
    .split(/[,\s]+/).map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function isAdminId(env, id) {
  return adminIds(env).includes(Number(id));
}

/* ---------- settings ---------- */

export function defaultSettings() {
  return {
    round: { round: 1, category: 'freestyle', note: 'anything goes' },
    inviteRequired: true,
    inviteCode: randomCode(8),
    rotation: 0,
    lastRefresh: null,
    log: []
  };
}

/* First run only: take the round from public/round.json, then the panel owns it. */
async function seedRound(env) {
  try {
    if (!env || !env.ASSETS) return null;
    const res = await env.ASSETS.fetch(new Request('https://hub.local/round.json'));
    if (!res || !res.ok) return null;
    const j = await res.json();
    if (!j || typeof j !== 'object') return null;
    const n = Number(j.round);
    return {
      round: Number.isInteger(n) && n > 0 ? n : 1,
      category: clean(j.category, 40).toLowerCase() || 'freestyle',
      note: clean(j.note, MAX_DESC)
    };
  } catch (e) {
    return null;
  }
}

function tidySettings(s) {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  return {
    round: s.round && typeof s.round === 'object' ? s.round : d.round,
    inviteRequired: s.inviteRequired !== false,
    inviteCode: typeof s.inviteCode === 'string' && s.inviteCode ? s.inviteCode : d.inviteCode,
    rotation: Number.isInteger(s.rotation) ? s.rotation : 0,
    lastRefresh: typeof s.lastRefresh === 'string' ? s.lastRefresh : null,
    log: Array.isArray(s.log) ? s.log.slice(0, LOG_KEEP) : []
  };
}

export async function getSettings(store, env) {
  const state = await getState(store);
  if (state.settings) return tidySettings(state.settings);
  const fresh = defaultSettings();
  const seeded = await seedRound(env);
  if (seeded) fresh.round = seeded;
  await update(store, (s) => {
    if (!s.settings) s.settings = fresh;
  });
  const after = await getState(store);
  return tidySettings(after.settings || fresh);
}

export async function saveSettings(store, settings) {
  await update(store, (s) => {
    s.settings = tidySettings(settings);
  });
}

export async function addLog(store, entry) {
  await update(store, (s) => {
    const settings = tidySettings(s.settings);
    settings.log.unshift({
      at: nowIso(),
      what: clean(entry.what, 40),
      who: clean(entry.who, 40),
      detail: clean(entry.detail, 120)
    });
    settings.log = settings.log.slice(0, LOG_KEEP);
    s.settings = settings;
  });
}

/* ---------- members ---------- */

export function memberRecord(user, joined) {
  return {
    id: Number(user.id),
    login: user.login,
    name: clean(user.name, MAX_NAME) || user.login,
    avatar: safeAvatar(user.avatar_url, user.id),
    bio: clean(user.bio, MAX_DESC),
    url: safeProfile(user.login),
    joined: joined || today(),
    seen: today()
  };
}

export async function getMember(store, id) {
  if (!isId(id)) return null;
  const state = await getState(store);
  return state.members[String(Number(id))] || null;
}

export async function putMember(store, member) {
  await update(store, (s) => {
    s.members[String(Number(member.id))] = member;
  });
}

export async function listMembers(store) {
  const state = await getState(store);
  return listOf(state.members)
    .filter((m) => m && isId(m.id) && isLogin(m.login))
    .sort((a, b) => String(b.joined || '').localeCompare(String(a.joined || '')) ||
      a.login.localeCompare(b.login));
}

export async function isBanned(store, id) {
  if (!isId(id)) return true;
  const state = await getState(store);
  return Boolean(state.bans[String(Number(id))]);
}

/* ---------- games ---------- */

export async function listGames(store) {
  const state = await getState(store);
  return listOf(state.games).filter((g) => g && isLogin(g.owner) && isRepoName(g.repo));
}

export async function gamesOfMember(store, ownerId) {
  const all = await listGames(store);
  return all.filter((g) => Number(g.ownerId) === Number(ownerId));
}

export function gameRecord(opts) {
  const meta = opts.meta;
  return {
    id: opts.owner + '/' + opts.repo,
    ownerId: Number(opts.ownerId),
    owner: opts.owner,
    repo: opts.repo,
    title: meta.title,
    description: meta.description,
    category: meta.category,
    emoji: meta.emoji,
    url: playUrl(opts.owner, opts.repo),
    repoUrl: repoUrl(opts.owner, opts.repo),
    stars: Number(opts.stars) || 0,
    updated: typeof opts.updated === 'string' ? opts.updated : null,
    added: opts.added || nowIso(),
    source: opts.source === 'topic' ? 'topic' : 'manual',
    /* Nothing is on show until its maker says so - however it got here. */
    status: opts.status === PUBLISHED ? PUBLISHED : DRAFT,
    /* true once a person typed the details: the refresh keeps its hands off */
    locked: Boolean(opts.locked),
    howto: typeof opts.howto === 'string' ? opts.howto : '',
    notes: typeof opts.notes === 'string' ? opts.notes : '',
    loves: Array.isArray(opts.loves) ? opts.loves.filter(isId) : [],
    cover: opts.cover || null,
    hidden: Boolean(opts.hidden),
    featured: Boolean(opts.featured),
    metaAt: nowIso()
  };
}

export function statusOf(game) {
  if (!game) return DRAFT;
  if (game.house) return PUBLISHED;
  return game.status === PUBLISHED ? PUBLISHED : DRAFT;
}

export function isPublished(game) {
  return statusOf(game) === PUBLISHED;
}

/* Who may look at this game at all: its owner, an admin, or anyone if it is published. */
export function maySee(env, game, session) {
  if (!game) return false;
  if (isPublished(game) && !game.hidden) return true;
  if (!session) return false;
  if (isAdminId(env, session.id)) return true;
  return Number(game.ownerId) === Number(session.id);
}

/*
 * Adds a repo as a game. The server checks ownership itself - the only thing it trusts
 * from the client is the repo name, and even that is looked up on the owner's own
 * account before anything is stored.
 */
export async function addGame(env, store, opts) {
  const { member, repoName, gh, roundCategory, by } = opts;
  if (!isRepoName(repoName)) return { ok: false, error: 'that is not a repo name' };
  if (isHubRepo(env, member.login, repoName, member.id)) {
    return { ok: false, error: 'that is the Hub itself' };
  }

  let repo;
  try {
    repo = await gh.getRepo(member.login, repoName);
  } catch (e) {
    return { ok: false, error: 'GitHub could not show that repo' };
  }
  if (!repoEligible(repo, member.id)) {
    return {
      ok: false,
      error: 'that repo is not eligible: it must be yours, public, not a fork, not archived, with GitHub Pages on'
    };
  }
  /* GitHub answers repo names case-insensitively, so check what it really handed back */
  if (isHubRepo(env, repo.owner && repo.owner.login, repo.name, repo.owner && repo.owner.id)) {
    return { ok: false, error: 'that is the Hub itself' };
  }

  const state = await getState(store);
  const mine = listOf(state.games).filter((g) => Number(g.ownerId) === Number(member.id));
  if (mine.find((g) => g.repo.toLowerCase() === repo.name.toLowerCase())) {
    return { ok: false, error: 'that game is already on the Hub' };
  }
  if (mine.length >= MAX_GAMES_PER_MEMBER) {
    return { ok: false, error: 'you are at the ' + MAX_GAMES_PER_MEMBER + ' game limit' };
  }
  const tomb = state.tombs[keyFor(member.id, repo.name)];
  if (tomb && tomb.by === 'admin' && by !== 'admin') {
    return { ok: false, error: 'the Hub owner removed this game; ask him about it' };
  }

  const hub = await gh.getHubJson(member.login, repo.name, repo.default_branch || 'main');
  const meta = normalizeHubJson(hub, {
    title: pretty(repo.name),
    description: typeof repo.description === 'string' ? repo.description : '',
    roundCategory: roundCategory,
    seed: member.login + '/' + repo.name
  });
  const rec = gameRecord({
    owner: member.login, ownerId: member.id, repo: repo.name, meta: meta,
    stars: repo.stargazers_count, updated: repo.pushed_at, source: opts.source || 'manual'
  });
  await update(store, (s) => {
    s.games[keyFor(member.id, repo.name)] = rec;
    delete s.tombs[keyFor(member.id, repo.name)];
    logInto(s, { what: 'game added', who: by === 'admin' ? 'admin' : member.login, detail: rec.id });
  });
  return { ok: true, game: rec };
}

function logInto(s, entry) {
  const settings = tidySettings(s.settings);
  settings.log.unshift({
    at: nowIso(),
    what: clean(entry.what, 40),
    who: clean(entry.who, 40),
    detail: clean(entry.detail, 120)
  });
  settings.log = settings.log.slice(0, LOG_KEEP);
  s.settings = settings;
}

/* by: 'member' | 'admin' - an admin tombstone a member cannot clear by re-adding. */
export async function removeGame(store, ownerId, repoName, by) {
  const key = keyFor(ownerId, repoName);
  const out = await update(store, (s) => {
    const existing = s.games[key];
    if (!existing) return noWrite({ ok: false, error: 'not on the Hub' });
    delete s.games[key];
    s.tombs[key] = { by: by === 'admin' ? 'admin' : 'member', at: nowIso() };
    logInto(s, { what: 'game removed', who: by, detail: existing.id });
    return { ok: true };
  });
  if (out && out.ok) await store.delete(coverKey(String(Number(ownerId)), repoName));
  return out;
}

/* ---------- the publish form ---------- */

export async function setGameMeta(store, game, fields, roundCategory, who) {
  const title = clean(fields.title, MAX_TITLE);
  if (!title) return { ok: false, error: 'a name is needed' };
  const key = keyFor(game.ownerId, game.repo);
  return update(store, (s) => {
    const current = s.games[key];
    if (!current) return noWrite({ ok: false, error: 'not on the Hub' });
    const next = Object.assign({}, current, {
      title: title,
      description: clean(fields.description, MAX_DESC),
      category: allowedCategory(fields.category, roundCategory) || current.category || 'freestyle',
      howto: cleanLines(fields.howto, MAX_LONG),
      notes: cleanLines(fields.notes, MAX_LONG),
      locked: true
    });
    s.games[key] = next;
    logInto(s, { what: 'details set', who: who, detail: next.id });
    return { ok: true, game: next };
  });
}

export async function setGameStatus(store, game, status, who) {
  const want = status === PUBLISHED ? PUBLISHED : DRAFT;
  const key = keyFor(game.ownerId, game.repo);
  return update(store, (s) => {
    const current = s.games[key];
    if (!current) return noWrite({ ok: false, error: 'not on the Hub' });
    if (want === PUBLISHED && !clean(current.title, MAX_TITLE)) {
      return noWrite({ ok: false, error: 'give it a name first' });
    }
    const next = Object.assign({}, current, { status: want });
    s.games[key] = next;
    logInto(s, { what: want === PUBLISHED ? 'published' : 'unpublished', who: who, detail: next.id });
    return { ok: true, game: next };
  });
}

/* ---------- covers ---------- */

export async function putCover(store, ownerKey, repo, bytes, type) {
  await store.putBytes(coverKey(ownerKey, repo), bytes, type);
  return { v: coverVersion(bytes), type: type };
}

/*
 * A counter the isolate cannot be trusted to keep. It lives in the Presence object when
 * that is reachable - no KV write at all - and falls back to the store when it is not.
 */
export async function allowance(env, store, key, limit, windowMs) {
  const presence = presenceClient(env);
  const live = await presence.rate(key, limit, windowMs);
  if (live && typeof live.ok === 'boolean') return live;
  const now = Date.now();
  const row = await store.get('rate:' + key);
  if (!row || typeof row.start !== 'number' || now - row.start > windowMs) {
    await store.put('rate:' + key, { start: now, n: 1 });
    return { ok: true, left: limit - 1 };
  }
  if (row.n >= limit) return { ok: false, left: 0 };
  await store.put('rate:' + key, { start: row.start, n: row.n + 1 });
  return { ok: true, left: limit - row.n - 1 };
}

export async function coverAllowance(env, store, whoKey) {
  return allowance(env, store, 'cover:' + whoKey, COVER_PER_HOUR, 3600000);
}

/* ---------- favourites ----------
 *
 * A favourite is private and uncounted: it is a list of game ids on the member's own
 * record, newest first. Nobody else ever learns what is on it, and nothing anywhere
 * adds the lists up - five friends and five "likes" on the best game said the wrong
 * thing about it, a pinned row of your own says the right one.
 */

export function favoritesOf(record) {
  const list = Array.isArray(record && record.favorites) ? record.favorites : [];
  const out = [];
  for (const id of list) {
    if (typeof id !== 'string' || !id || id.length > 150) continue;
    if (out.some((x) => x.toLowerCase() === id.toLowerCase())) continue;
    out.push(id);
  }
  return out.slice(0, MAX_FAVORITES);
}

/* Drops favourites pointing at a game that is not on the Hub any more. */
export async function pruneFavorites(env, store) {
  const houseIds = houseGames(env).map((g) => g.id.toLowerCase());
  return update(store, (s) => {
    const live = new Set(houseIds.concat(
      listOf(s.games).map((g) => String(g.id).toLowerCase())
    ));
    let changed = 0;
    for (const key of Object.keys(s.members)) {
      const rec = s.members[key];
      const favs = favoritesOf(rec);
      const kept = favs.filter((id) => live.has(id.toLowerCase()));
      if (kept.length !== favs.length) {
        rec.favorites = kept;
        changed++;
      }
    }
    return changed ? changed : noWrite(0);
  });
}

/* ---------- loves ---------- */

function lovesOf(record) {
  return Array.isArray(record && record.loves) ? record.loves.filter(isId) : [];
}

/* One write, and only when something actually changed: pressing love twice is free. */
export async function setLove(env, store, id, memberId, on) {
  if (!isId(memberId)) return { ok: false, error: 'sign in first' };
  const wanted = String(id || '');

  if (wanted.indexOf('house/') === 0) {
    const slug = wanted.slice('house/'.length);
    if (!houseGames(env).find((g) => g.id === wanted)) return { ok: false, error: 'no such game' };
    return update(store, (s) => {
      const before = s.house[slug] || {};
      const loves = lovesOf(before);
      const next = on
        ? (loves.indexOf(memberId) < 0 ? loves.concat([memberId]) : loves)
        : loves.filter((x) => x !== memberId);
      const same = next.length === loves.length;
      if (!same) s.house[slug] = Object.assign({}, before, { loves: next });
      const answer = { ok: true, loves: next.length, lovedByMe: next.indexOf(memberId) >= 0 };
      return same ? noWrite(answer) : answer;
    });
  }

  return update(store, (s) => {
    const key = Object.keys(s.games).find((k) =>
      s.games[k] && String(s.games[k].id).toLowerCase() === wanted.toLowerCase());
    if (!key) return noWrite({ ok: false, error: 'no such game' });
    const game = s.games[key];
    if (!isPublished(game) || game.hidden) {
      return noWrite({ ok: false, error: 'that game is not published' });
    }
    const loves = lovesOf(game);
    const next = on
      ? (loves.indexOf(memberId) < 0 ? loves.concat([memberId]) : loves)
      : loves.filter((x) => x !== memberId);
    const same = next.length === loves.length;
    if (!same) s.games[key] = Object.assign({}, game, { loves: next });
    const answer = { ok: true, loves: next.length, lovedByMe: next.indexOf(memberId) >= 0 };
    return same ? noWrite(answer) : answer;
  });
}

/* A report is a line in the owner's activity log and nothing else. */
export async function reportGame(env, store, id, who) {
  const wanted = clean(id, 150);
  const state = await getState(store);
  const all = listOf(state.games).map((g) => g.id).concat(houseGames(env).map((g) => g.id));
  const found = all.find((x) => String(x).toLowerCase() === wanted.toLowerCase());
  if (!found) return { ok: false, error: 'no such game' };
  await addLog(store, { what: 'reported', who: who, detail: found });
  return { ok: true };
}

/* ---------- house games ---------- */

export async function houseGamesWithEdits(env, store) {
  const state = await getState(store);
  return houseGames(env).map((g) => {
    const e = state.house[g.id.slice('house/'.length)];
    if (!e) return g;
    return Object.assign({}, g, {
      title: clean(e.title, MAX_TITLE) || g.title,
      description: typeof e.description === 'string' ? clean(e.description, MAX_DESC) : g.description,
      category: allowedCategory(e.category) || g.category,
      howto: typeof e.howto === 'string' ? e.howto : '',
      notes: typeof e.notes === 'string' ? e.notes : '',
      loves: Array.isArray(e.loves) ? e.loves : [],
      cover: e.cover || null
    });
  });
}

/* ---------- what the pages read ---------- */

export function publicGame(g, meId) {
  const loves = lovesOf(g);
  return {
    id: g.id,
    owner: g.owner,
    repo: g.repo || null,
    title: g.title,
    description: g.description,
    howto: g.howto || '',
    notes: g.notes || '',
    category: g.category,
    url: g.url,
    repoUrl: g.repoUrl,
    stars: g.stars || 0,
    updated: g.updated || null,
    added: g.added || null,
    featured: Boolean(g.featured),
    house: Boolean(g.house),
    status: statusOf(g),
    loves: loves.length,
    lovedByMe: meId ? loves.indexOf(Number(meId)) >= 0 : false,
    active: 0,
    visits: 0,
    cover: coverUrl(g.house ? 'house' : String(Number(g.ownerId)), g.repo, g.cover)
  };
}

function presenceOf(member, snap, nowMs) {
  if (member.hidePresence) return { state: 'offline' };
  const row = snap.members[String(member.id)];
  if (row) return { state: row.game ? 'playing' : 'online', game: row.game || null };
  return { state: 'offline', lastSeen: member.lastSeen || null };
}

export async function hubPayload(env, store, session) {
  const settings = await getSettings(store, env);
  const state = await getState(store);
  const members = listOf(state.members)
    .filter((m) => m && isId(m.id) && isLogin(m.login))
    .sort((a, b) => String(b.joined || '').localeCompare(String(a.joined || '')) ||
      a.login.localeCompare(b.login));
  const stored = listOf(state.games).filter((g) => g && isLogin(g.owner) && isRepoName(g.repo));
  const house = await houseGamesWithEdits(env, store);
  /* Loading a page is itself a sign of life, unless the person asked to be invisible. */
  const meRec = session ? state.members[String(Number(session.id))] : null;
  const touchMe = meRec && !meRec.hidePresence ? meRec.id : null;
  const snap = await presenceClient(env).snapshot(touchMe);

  /* Drafts belong to their maker (so they can set them up and test them) and to the
     Hub owner. To everybody else they do not exist at all. */
  const mine = session ? Number(session.id) : 0;
  const admin = Boolean(session && isAdminId(env, session.id));
  const onShow = stored.filter((g) => !g.hidden && isPublished(g));
  const forMe = stored.filter((g) => !isPublished(g) && (admin || Number(g.ownerId) === mine));
  const games = onShow.concat(forMe).map((g) => publicGame(g, mine))
    .concat(house.map((g) => publicGame(g, mine)));

  for (const g of games) {
    g.active = Number(snap.active[g.id]) || 0;
    g.visits = Number(snap.visits[g.id]) || 0;
  }

  /* Who loves what is public on a profile, by design - that is the "Loved games" box. */
  const lovedBy = new Map();
  for (const g of onShow.concat(house)) {
    for (const id of lovesOf(g)) {
      if (!lovedBy.has(id)) lovedBy.set(id, []);
      lovedBy.get(id).push(g.id);
    }
  }

  /* a profile counts what the world can see, never someone's drafts */
  const counts = new Map();
  for (const g of onShow) {
    const k = g.owner.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  games.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) ||
    String(b.updated || '').localeCompare(String(a.updated || '')) || a.id.localeCompare(b.id));
  const roundCat = settings.round && settings.round.category;

  /* "last seen" is written at most once every six hours per member */
  const nowMs = Date.now();
  const stale = members.filter((m) => snap.members[String(m.id)] &&
    (!m.lastSeen || nowMs - Date.parse(m.lastSeen) > LAST_SEEN_EVERY));
  if (stale.length) {
    await update(store, (s) => {
      for (const m of stale) {
        const rec = s.members[String(m.id)];
        if (rec) rec.lastSeen = new Date(nowMs).toISOString();
      }
    });
  }

  return {
    v: 4,
    built: nowIso(),
    round: settings.round,
    categories: CATEGORIES.concat(
      roundCat && CATEGORIES.indexOf(roundCat) < 0 ? [roundCat] : []
    ),
    me: session ? {
      id: session.id, login: session.login, admin: admin
    } : null,
    members: members.map((m) => ({
      login: m.login,
      id: m.id,
      name: m.name,
      avatar: m.avatar,
      bio: m.bio,
      url: m.url,
      joined: m.joined,
      games: counts.get(m.login.toLowerCase()) || 0,
      loved: lovedBy.get(m.id) || [],
      hidePresence: Boolean(m.hidePresence),
      presence: presenceOf(m, snap, nowMs)
    })),
    games: games
  };
}

/* ---------- the 15 minute refresh ---------- */

export async function refresh(env, store, opts) {
  const o = opts || {};
  const budget = o.budget || makeBudget(45);
  const gh = o.gh || makeGitHub(env, budget);
  const topic = topicOf(env);
  const settings = await getSettings(store, env);
  const roundCategory = settings.round && settings.round.category;
  const members = (await listMembers(store)).slice().sort((a, b) => a.id - b.id);
  const summary = { members: members.length, checked: 0, added: 0, removed: 0, updated: 0, errors: 0 };

  if (!members.length) {
    await update(store, (s) => {
      const set = tidySettings(s.settings);
      set.lastRefresh = nowIso();
      s.settings = set;
    });
    summary.used = budget.used;
    return summary;
  }

  const batch = Math.max(1, Math.min(Number(o.batch) || REFRESH_BATCH, members.length));
  let start = Number.isInteger(settings.rotation) ? settings.rotation : 0;
  if (start < 0 || start >= members.length) start = 0;

  for (let n = 0; n < batch; n++) {
    if (budget.left() < 3) break;
    const member = members[(start + n) % members.length];
    try {
      await refreshMember(env, store, gh, budget, member, topic, roundCategory, summary);
      summary.checked++;
    } catch (e) {
      /* A GitHub hiccup, a rate limit or a spent budget must never delete anything. */
      summary.errors++;
      if (e instanceof BudgetError) break;
    }
  }

  summary.loves = await pruneLoves(env, store, await listMembers(store));
  summary.favorites = await pruneFavorites(env, store);
  summary.hubRepo = await purgeHubRepo(env, store);

  await update(store, (s) => {
    const set = tidySettings(s.settings);
    set.rotation = (start + batch) % members.length;
    set.lastRefresh = nowIso();
    s.settings = set;
  });
  summary.used = budget.used;
  return summary;
}

/* Drops loves belonging to ids that are not members any more. */
export async function pruneLoves(env, store, members) {
  const alive = new Set((members || []).map((m) => Number(m.id)));
  return update(store, (s) => {
    let changed = 0;
    for (const key of Object.keys(s.games)) {
      const g = s.games[key];
      const loves = lovesOf(g);
      const kept = loves.filter((id) => alive.has(Number(id)));
      if (kept.length !== loves.length) {
        s.games[key] = Object.assign({}, g, { loves: kept });
        changed++;
      }
    }
    for (const slug of Object.keys(s.house)) {
      const h = s.house[slug];
      const loves = lovesOf(h);
      const kept = loves.filter((id) => alive.has(Number(id)));
      if (kept.length !== loves.length) {
        s.house[slug] = Object.assign({}, h, { loves: kept });
        changed++;
      }
    }
    return changed ? changed : noWrite(0);
  });
}

const MISSES_BEFORE_HIDING = 3;

/* The account did not answer by id. Three refreshes like that and its games go out of
   the arcade - hidden, never deleted, so the owner decides. */
async function markMissing(store, member, summary) {
  summary.errors++;
  const hidden = await update(store, (s) => {
    const rec = s.members[String(member.id)] || member;
    const misses = (Number(rec.misses) || 0) + 1;
    s.members[String(member.id)] = Object.assign({}, rec, {
      misses: misses, gone: misses >= MISSES_BEFORE_HIDING
    });
    if (misses < MISSES_BEFORE_HIDING) return 0;
    let n = 0;
    for (const key of Object.keys(s.games)) {
      const g = s.games[key];
      if (Number(g.ownerId) !== Number(member.id) || g.hidden) continue;
      s.games[key] = Object.assign({}, g, { hidden: true });
      n++;
    }
    if (n || misses === MISSES_BEFORE_HIDING) {
      logInto(s, {
        what: 'account gone', who: 'refresh',
        detail: member.login + ': ' + n + ' games hidden after ' + misses + ' tries'
      });
    }
    return n;
  });
  return hidden;
}

async function refreshMember(env, store, gh, budget, member, topic, roundCategory, summary) {
  /* Always by numeric id: GitHub hands back the account's CURRENT login, so someone
     renaming themselves just carries their games along. */
  let user;
  try {
    user = await gh.getUserById(member.id);
  } catch (e) {
    if (e && e.status === 404) {
      await markMissing(store, member, summary);
      return;
    }
    throw e;
  }
  if (!user || Number(user.id) !== Number(member.id) || !isLogin(user.login)) {
    summary.errors++;
    return;
  }

  const renamedFrom = member.login !== user.login ? member.login : null;
  const repos = await gh.listRepos(user.login);
  const eligible = repos.filter((r) => repoEligible(r, user.id));
  const byName = new Map(eligible.map((r) => [r.name.toLowerCase(), r]));

  /* hub.json for anything new or stale, fetched before the write so the document is
     read and written in one short moment */
  const state = await getState(store);
  const mine = listOf(state.games).filter((g) => Number(g.ownerId) === Number(member.id));
  const live = mine.filter((g) => byName.has(g.repo.toLowerCase()));
  const have = new Set(live.map((g) => g.repo.toLowerCase()));
  const fetched = [];

  for (const r of eligible) {
    if (budget.left() < 2) break;
    if (have.size + fetched.length >= MAX_GAMES_PER_MEMBER) break;
    if (have.has(r.name.toLowerCase())) continue;
    if (isHubRepo(env, user.login, r.name, user.id)) continue;
    if (!hasTopic(r, topic)) continue;
    if (state.tombs[keyFor(member.id, r.name)]) continue;
    const hub = await gh.getHubJson(user.login, r.name, r.default_branch || 'main');
    fetched.push({ repo: r, hub: hub, isNew: true });
  }

  const order = live.slice().sort((a, b) =>
    String(a.metaAt || '').localeCompare(String(b.metaAt || '')));
  for (const g of order.slice(0, META_PER_MEMBER)) {
    if (budget.left() < 2) break;
    const r = byName.get(g.repo.toLowerCase());
    const hub = await gh.getHubJson(user.login, r.name, r.default_branch || 'main');
    fetched.push({ repo: r, hub: hub, isNew: false });
  }

  /* One read-modify-write at the end: anything a member changed while GitHub was
     answering is still in the document we are about to edit, so it survives. */
  await update(store, (s) => {
    const rec = s.members[String(member.id)] || member;
    s.members[String(member.id)] = Object.assign({}, rec, {
      login: user.login,
      name: clean(user.name, MAX_NAME) || user.login,
      avatar: safeAvatar(user.avatar_url, user.id),
      bio: clean(user.bio, MAX_DESC),
      url: safeProfile(user.login),
      misses: 0,
      gone: false
    });
    summary.updated++;

    if (renamedFrom) {
      for (const key of Object.keys(s.games)) {
        const g = s.games[key];
        if (Number(g.ownerId) !== Number(member.id)) continue;
        s.games[key] = Object.assign({}, g, {
          id: user.login + '/' + g.repo,
          owner: user.login,
          url: playUrl(user.login, g.repo),
          repoUrl: repoUrl(user.login, g.repo)
        });
      }
      logInto(s, {
        what: 'renamed', who: 'refresh', detail: renamedFrom + ' is now ' + user.login
      });
    }

    /* gone, private, archived, Pages off, renamed or moved: drop it, no tombstone */
    for (const key of Object.keys(s.games)) {
      const g = s.games[key];
      if (Number(g.ownerId) !== Number(member.id)) continue;
      if (!byName.has(g.repo.toLowerCase())) {
        delete s.games[key];
        logInto(s, { what: 'game gone', who: 'refresh', detail: g.id });
        summary.removed++;
      }
    }

    for (const item of fetched) {
      const r = item.repo;
      const key = keyFor(member.id, r.name);
      const current = s.games[key];
      if (item.isNew && current) continue;
      if (item.isNew && s.tombs[key]) continue;
      const meta = normalizeHubJson(item.hub, {
        title: pretty(r.name),
        description: typeof r.description === 'string' ? r.description : '',
        roundCategory: roundCategory,
        seed: user.login + '/' + r.name
      });
      const base = current || {};
      const next = gameRecord({
        owner: user.login, ownerId: user.id, repo: r.name, meta: meta,
        stars: r.stargazers_count, updated: r.pushed_at,
        source: current ? current.source : 'topic',
        status: current ? statusOf(current) : DRAFT,
        locked: base.locked, howto: base.howto, notes: base.notes, loves: base.loves,
        cover: base.cover, hidden: base.hidden, featured: base.featured, added: base.added
      });
      /* Once a person has typed the details, hub.json stops having a say. */
      if (base.locked) {
        next.title = base.title;
        next.description = base.description;
        next.category = base.category;
        next.emoji = base.emoji;
        next.howto = base.howto || '';
        next.notes = base.notes || '';
      }
      if (!current) {
        s.games[key] = next;
        logInto(s, { what: 'game added', who: 'topic', detail: next.id });
        summary.added++;
      } else {
        const before = Object.assign({}, current);
        const after = Object.assign({}, next);
        delete before.metaAt;
        delete after.metaAt;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          s.games[key] = next;
          summary.updated++;
        }
      }
    }
  });
}
