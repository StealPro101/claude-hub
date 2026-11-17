/*
 * The Hub itself: settings, members, games, the payload the pages read, and the
 * 15-minute refresh that picks up games a member (or their Claude) tagged.
 */

import {
  clean, pretty, isLogin, isRepoName, isId, normalizeHubJson, playUrl, repoUrl,
  safeAvatar, safeProfile, repoEligible, hasTopic, gameKey, tombKey, SLUG_RE,
  MAX_NAME, MAX_DESC
} from './validate.js';
import { putIfChanged } from './store.js';
import { makeGitHub, makeBudget, BudgetError } from './github.js';
import { nowIso, today, randomCode } from './util.js';

export const DEFAULT_TOPIC = 'claude-hub-game';
export const MAX_GAMES_PER_MEMBER = 20;
const REFRESH_BATCH = 4;
const META_PER_MEMBER = 6;
const LOG_KEEP = 50;

/*
 * The Hub's own house games. They stay in games/<slug>/ in this repo, served by GitHub
 * Pages at https://<HUB_OWNER_LOGIN>.github.io/<HUB_REPO>/games/<slug>/ - exactly where
 * they have always been, so everyone's saved progress survives. From the Hub's side a
 * house game is just another game on somebody's Pages site, framed like the rest.
 * Add a folder in games/ and a line here to add another.
 */
export const HOUSE_GAMES = [
  {
    slug: 'rare-pull',
    title: 'Rare Pull',
    description: 'Anime trivia climb: pull cards, answer fast, duel a friend with a challenge code.',
    category: 'trivia',
    emoji: '\u{1F3B4}',
    updated: '2026-08-29T00:00:00Z'
  },
  {
    slug: 'neon-snake',
    title: 'Neon Snake',
    description: 'The house snake. Simple, fast, and still unbeaten.',
    category: 'demo',
    emoji: '\u{1F40D}',
    updated: '2026-08-28T00:00:00Z'
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

/* The same computed-from-owner rule as every other game, one folder deeper. */
export function houseGames(env) {
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
    category: g.category,
    emoji: g.emoji,
    url: base + 'games/' + g.slug + '/',
    repoUrl: repoUrl(owner, repo),
    stars: 0,
    updated: g.updated,
    house: true
  }));
}

export function topicOf(env) {
  return clean(env && env.HUB_TOPIC, 50).toLowerCase() || DEFAULT_TOPIC;
}

export function adminIds(env) {
  return String((env && env.ADMIN_GITHUB_IDS) || '')
    .split(/[,\s]+/).map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function isAdminId(env, id) {
  return adminIds(env).includes(Number(id));
}

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

/* First run only: take the round from public/round.json, then the admin panel owns it. */
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

export async function getSettings(store, env) {
  const s = await store.get('settings');
  if (s && typeof s === 'object') {
    const d = defaultSettings();
    return {
      round: s.round && typeof s.round === 'object' ? s.round : d.round,
      inviteRequired: s.inviteRequired !== false,
      inviteCode: typeof s.inviteCode === 'string' && s.inviteCode ? s.inviteCode : d.inviteCode,
      rotation: Number.isInteger(s.rotation) ? s.rotation : 0,
      lastRefresh: typeof s.lastRefresh === 'string' ? s.lastRefresh : null,
      log: Array.isArray(s.log) ? s.log.slice(0, LOG_KEEP) : []
    };
  }
  const fresh = defaultSettings();
  const seeded = await seedRound(env);
  if (seeded) fresh.round = seeded;
  await store.put('settings', fresh);
  return fresh;
}

export async function saveSettings(store, settings) {
  await store.put('settings', settings);
}

export async function addLog(store, entry) {
  const s = await getSettings(store);
  s.log.unshift({
    at: nowIso(),
    what: clean(entry.what, 40),
    who: clean(entry.who, 40),
    detail: clean(entry.detail, 120)
  });
  s.log = s.log.slice(0, LOG_KEEP);
  await saveSettings(store, s);
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
  return store.get('member:' + Number(id));
}

export async function listMembers(store) {
  const rows = await store.list('member:');
  return rows.map((r) => r.value)
    .filter((m) => m && isId(m.id) && isLogin(m.login))
    .sort((a, b) => String(b.joined || '').localeCompare(String(a.joined || '')) ||
      a.login.localeCompare(b.login));
}

export async function isBanned(store, id) {
  if (!isId(id)) return true;
  return Boolean(await store.get('ban:' + Number(id)));
}

/* ---------- games ---------- */

export async function listGames(store) {
  const rows = await store.list('game:');
  return rows.map((r) => r.value).filter((g) => g && isLogin(g.owner) && isRepoName(g.repo));
}

export async function gamesOfMember(store, ownerId) {
  const rows = await store.list('game:' + Number(ownerId) + '/');
  return rows.map((r) => r.value).filter(Boolean);
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
    hidden: Boolean(opts.hidden),
    featured: Boolean(opts.featured),
    metaAt: nowIso()
  };
}

/*
 * Adds a repo as a game. The server checks ownership itself - the only thing it
 * trusts from the client is the repo name, and even that is looked up on the owner's
 * own account before anything is stored.
 */
export async function addGame(env, store, opts) {
  const { member, repoName, gh, roundCategory, by } = opts;
  if (!isRepoName(repoName)) return { ok: false, error: 'that is not a repo name' };

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

  const mine = await gamesOfMember(store, member.id);
  const already = mine.find((g) => g.repo.toLowerCase() === repo.name.toLowerCase());
  if (already) return { ok: false, error: 'that game is already on the Hub' };
  if (mine.length >= MAX_GAMES_PER_MEMBER) {
    return { ok: false, error: 'you are at the ' + MAX_GAMES_PER_MEMBER + ' game limit' };
  }

  const tomb = await store.get(tombKey(member.id, repo.name));
  if (tomb && tomb.by === 'admin' && by !== 'admin') {
    return { ok: false, error: 'the Hub owner removed this game; ask him about it' };
  }
  if (tomb) await store.delete(tombKey(member.id, repo.name));

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
  await store.put(gameKey(member.id, repo.name), rec);
  await addLog(store, {
    what: 'game added', who: by === 'admin' ? 'admin' : member.login, detail: rec.id
  });
  return { ok: true, game: rec };
}

/* by: 'member' | 'admin' - an admin tombstone a member cannot clear by re-adding. */
export async function removeGame(store, ownerId, repoName, by) {
  const key = gameKey(ownerId, repoName);
  const existing = await store.get(key);
  if (!existing) return { ok: false, error: 'not on the Hub' };
  await store.delete(key);
  await store.put(tombKey(ownerId, repoName), { by: by === 'admin' ? 'admin' : 'member', at: nowIso() });
  await addLog(store, { what: 'game removed', who: by, detail: existing.id });
  return { ok: true };
}

/* ---------- what the pages read ---------- */

export function publicGame(g) {
  return {
    id: g.id,
    owner: g.owner,
    title: g.title,
    description: g.description,
    category: g.category,
    emoji: g.emoji,
    url: g.url,
    repoUrl: g.repoUrl,
    stars: g.stars || 0,
    updated: g.updated || null,
    featured: Boolean(g.featured),
    house: Boolean(g.house)
  };
}

export async function hubPayload(env, store, session) {
  const settings = await getSettings(store, env);
  const members = await listMembers(store);
  const stored = await listGames(store);
  const visible = stored.filter((g) => !g.hidden).map(publicGame);
  const games = visible.concat(houseGames(env).map(publicGame));

  const counts = new Map();
  for (const g of visible) {
    const k = g.owner.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  games.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) ||
    String(b.updated || '').localeCompare(String(a.updated || '')) || a.id.localeCompare(b.id));

  return {
    v: 3,
    built: nowIso(),
    round: settings.round,
    me: session ? {
      id: session.id, login: session.login, admin: isAdminId(env, session.id)
    } : null,
    members: members.map((m) => ({
      login: m.login,
      id: m.id,
      name: m.name,
      avatar: m.avatar,
      bio: m.bio,
      url: m.url,
      joined: m.joined,
      games: counts.get(m.login.toLowerCase()) || 0
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
    settings.lastRefresh = nowIso();
    await saveSettings(store, settings);
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

  settings.rotation = (start + batch) % members.length;
  settings.lastRefresh = nowIso();
  await saveSettings(store, settings);
  summary.used = budget.used;
  return summary;
}

const MISSES_BEFORE_HIDING = 3;

/* The account did not answer by id. Three refreshes in a row like that and we take
   their games out of the arcade - hidden, never deleted, so the owner decides. */
async function markMissing(store, member, summary) {
  const misses = (Number(member.misses) || 0) + 1;
  const next = Object.assign({}, member, { misses: misses, gone: misses >= MISSES_BEFORE_HIDING });
  await store.put('member:' + member.id, next);
  summary.errors++;
  if (misses < MISSES_BEFORE_HIDING) return;
  let hidden = 0;
  for (const g of await gamesOfMember(store, member.id)) {
    if (g.hidden) continue;
    await store.put(gameKey(member.id, g.repo), Object.assign({}, g, { hidden: true }));
    hidden++;
  }
  if (hidden || misses === MISSES_BEFORE_HIDING) {
    await addLog(store, {
      what: 'account gone', who: 'refresh',
      detail: member.login + ': ' + hidden + ' games hidden after ' + misses + ' tries'
    });
  }
}

/* A rename changes the play address, so every stored game follows the new login. */
async function renameGames(store, ownerId, login, summary) {
  for (const g of await gamesOfMember(store, ownerId)) {
    const next = Object.assign({}, g, {
      id: login + '/' + g.repo,
      owner: login,
      url: playUrl(login, g.repo),
      repoUrl: repoUrl(login, g.repo)
    });
    if (!next.url || !next.repoUrl) continue;
    await store.put(gameKey(ownerId, g.repo), next);
    summary.updated++;
  }
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
  const fresh = Object.assign({}, member, {
    login: user.login,
    name: clean(user.name, MAX_NAME) || user.login,
    avatar: safeAvatar(user.avatar_url, user.id),
    bio: clean(user.bio, MAX_DESC),
    url: safeProfile(user.login),
    misses: 0,
    gone: false
  });
  if (await putIfChanged(store, 'member:' + member.id, fresh)) summary.updated++;
  if (renamedFrom) {
    await renameGames(store, member.id, user.login, summary);
    await addLog(store, {
      what: 'renamed', who: 'refresh', detail: renamedFrom + ' is now ' + user.login
    });
  }

  const repos = await gh.listRepos(user.login);
  const eligible = repos.filter((r) => repoEligible(r, user.id));
  const byName = new Map(eligible.map((r) => [r.name.toLowerCase(), r]));
  const mine = await gamesOfMember(store, member.id);

  /* gone, private, archived, Pages off, renamed or moved: drop it, no tombstone */
  for (const g of mine) {
    if (!byName.has(g.repo.toLowerCase())) {
      await store.delete(gameKey(member.id, g.repo));
      await addLog(store, { what: 'game gone', who: 'refresh', detail: g.id });
      summary.removed++;
    }
  }
  const live = mine.filter((g) => byName.has(g.repo.toLowerCase()));
  const have = new Set(live.map((g) => g.repo.toLowerCase()));

  /* "their Claude adds a game": the topic is enough, unless it was removed on purpose */
  for (const r of eligible) {
    if (budget.left() < 2) break;
    if (have.size >= MAX_GAMES_PER_MEMBER) break;
    if (have.has(r.name.toLowerCase())) continue;
    if (!hasTopic(r, topic)) continue;
    if (await store.get(tombKey(member.id, r.name))) continue;
    const hub = await gh.getHubJson(user.login, r.name, r.default_branch || 'main');
    const meta = normalizeHubJson(hub, {
      title: pretty(r.name),
      description: typeof r.description === 'string' ? r.description : '',
      roundCategory: roundCategory,
      seed: user.login + '/' + r.name
    });
    const rec = gameRecord({
      owner: user.login, ownerId: user.id, repo: r.name, meta: meta,
      stars: r.stargazers_count, updated: r.pushed_at, source: 'topic'
    });
    await store.put(gameKey(member.id, r.name), rec);
    await addLog(store, { what: 'game added', who: 'topic', detail: rec.id });
    have.add(r.name.toLowerCase());
    summary.added++;
  }

  /* freshen the oldest handful, so one busy member cannot eat the whole budget */
  const order = live.slice().sort((a, b) => String(a.metaAt || '').localeCompare(String(b.metaAt || '')));
  for (const g of order.slice(0, META_PER_MEMBER)) {
    if (budget.left() < 2) break;
    const r = byName.get(g.repo.toLowerCase());
    const hub = await gh.getHubJson(user.login, r.name, r.default_branch || 'main');
    const meta = normalizeHubJson(hub, {
      title: pretty(r.name),
      description: typeof r.description === 'string' ? r.description : '',
      roundCategory: roundCategory,
      seed: user.login + '/' + r.name
    });
    const next = Object.assign({}, g, gameRecord({
      owner: user.login, ownerId: user.id, repo: r.name, meta: meta,
      stars: r.stargazers_count, updated: r.pushed_at, source: g.source,
      hidden: g.hidden, featured: g.featured, added: g.added
    }));
    const before = Object.assign({}, g);
    delete before.metaAt;
    const after = Object.assign({}, next);
    delete after.metaAt;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await store.put(gameKey(member.id, r.name), next);
      summary.updated++;
    }
  }
}
