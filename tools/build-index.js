#!/usr/bin/env node
/*
 * Claude Hub v3 indexer.
 *
 * Reads members.json / blocked.json / hub.config.json / round.json and the Hub's own
 * games/ folder, asks the public GitHub API what each member owns, and writes
 * data/hub-data.json - the only thing the website reads.
 *
 * Zero dependencies, Node 20+ (global fetch).
 *
 *   node tools/build-index.js
 *   node tools/build-index.js --prev prev/hub-data.json --out data/hub-data.json --emit-changed
 *
 * A token in GITHUB_TOKEN is used if present, and is sent ONLY to api.github.com.
 * Everything still works without one (60 requests/hour).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.github.com/';
const RAW_BASE = 'https://raw.githubusercontent.com/';
const UA = 'claude-hub-indexer';

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const MAX_TITLE = 60;
const MAX_DESC = 200;

const CATEGORIES = [
  'freestyle', 'arcade', 'action', 'puzzle', 'platformer', 'shooter', 'racing',
  'strategy', 'trivia', 'idle', 'horror', 'sandbox', 'sports', 'card', 'rhythm',
  'demo', 'other'
];

const ICONS = ['\u{1F3AE}', '\u{1F47E}', '\u{1F579}️', '\u{1F680}', '\u{1F40D}', '\u{1F9E9}',
  '⚔️', '\u{1F3CE}️', '\u{1F6F8}', '\u{1F3AF}', '\u{1F409}', '\u{1F4A5}',
  '\u{1F3B2}', '\u{1F451}', '\u{1F9CA}', '\u{1F525}'];

/* ---------- small pure helpers ---------- */

function graphemeCount(s) {
  const str = String(s);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(str)) n++;
    return n;
  }
  return Array.from(str).length;
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max).trim();
  return s;
}

function pretty(name) {
  return String(name || '')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function iconFor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ICONS[h % ICONS.length];
}

function isValidLogin(login) {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

function isValidRepoName(name) {
  return typeof name === 'string' && REPO_RE.test(name);
}

/* The play address is always computed from owner + repo, never taken from text a
   member supplied. That is what enforces "only things on your own account". */
function playUrl(login, repo) {
  if (!isValidLogin(login) || !isValidRepoName(repo)) return null;
  const host = login.toLowerCase() + '.github.io';
  if (repo.toLowerCase() === host) return 'https://' + host + '/';
  return 'https://' + host + '/' + repo + '/';
}

function repoUrl(login, repo) {
  if (!isValidLogin(login) || !isValidRepoName(repo)) return null;
  return 'https://github.com/' + login + '/' + repo;
}

function isOkEmoji(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/^[A-Za-z0-9]$/.test(s)) return false;
  return graphemeCount(s) === 1;
}

function allowedCategory(value, extraCategory) {
  const c = clean(value, 40).toLowerCase();
  if (!c) return null;
  if (CATEGORIES.includes(c)) return c;
  const extra = clean(extraCategory, 40).toLowerCase();
  if (extra && c === extra) return c;
  return null;
}

/* hub.json is member-supplied: validate and cap every field, fall back otherwise. */
function normalizeHubJson(raw, fallbacks) {
  const fb = fallbacks || {};
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = clean(obj.title, MAX_TITLE) || clean(fb.title, MAX_TITLE) || 'Untitled';
  const description = clean(obj.description, MAX_DESC) || clean(fb.description, MAX_DESC) || '';
  const category = allowedCategory(obj.category, fb.roundCategory) || 'freestyle';
  const emoji = isOkEmoji(obj.emoji) ? obj.emoji.trim() : iconFor(fb.seed || title);
  return { title, description, category, emoji };
}

function blockedSets(blocked) {
  const b = blocked && typeof blocked === 'object' ? blocked : {};
  const logins = new Set((Array.isArray(b.logins) ? b.logins : [])
    .filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()));
  const repos = new Set((Array.isArray(b.repos) ? b.repos : [])
    .filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()));
  return { logins, repos };
}

/* Keeps only repos that pass every Hub rule, then caps the count. */
function filterRepos(repos, opts) {
  const o = opts || {};
  const topic = String(o.topic || '').toLowerCase();
  const blockedRepos = o.blockedRepos instanceof Set ? o.blockedRepos : new Set();
  const max = Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : 20;
  const out = [];
  for (const r of Array.isArray(repos) ? repos : []) {
    if (!r || typeof r !== 'object') continue;
    if (!isValidRepoName(r.name)) continue;
    const owner = r.owner && r.owner.login ? r.owner.login : o.login;
    if (!isValidLogin(owner)) continue;
    const topics = Array.isArray(r.topics) ? r.topics.map((t) => String(t).toLowerCase()) : [];
    if (!topics.includes(topic)) continue;
    if (r.fork === true) continue;
    if (r.private === true) continue;
    if (r.archived === true) continue;
    if (r.disabled === true) continue;
    if (r.has_pages !== true) continue;
    const full = (owner + '/' + r.name).toLowerCase();
    if (blockedRepos.has(full) || blockedRepos.has(r.name.toLowerCase())) continue;
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------- legacy games that live in this repo ---------- */

function readLegacyGames(rootDir, owner, roundCategory) {
  const dir = path.join(rootDir, 'games');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (e) {
    return [];
  }
  const games = [];
  for (const slug of names) {
    if (!SLUG_RE.test(slug)) continue;
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, slug, 'info.json'), 'utf8'));
    } catch (e) {
      info = {};
    }
    const meta = normalizeHubJson(info, {
      title: pretty(slug),
      description: info && typeof info.description === 'string' ? info.description : '',
      roundCategory: roundCategory,
      seed: slug
    });
    games.push({
      id: owner + '/' + slug,
      owner: owner,
      title: meta.title,
      description: meta.description,
      category: meta.category,
      emoji: meta.emoji,
      url: 'games/' + slug + '/',
      repoUrl: 'https://github.com/' + owner + '/claude-hub/tree/main/games/' + slug,
      stars: 0,
      updated: typeof info.added === 'string' ? info.added : null,
      legacy: true
    });
  }
  return games;
}

/* ---------- the GitHub side, injectable for tests ---------- */

function makeApi(opts) {
  const o = opts || {};
  const token = o.token || '';
  const doFetch = o.fetchImpl || ((...a) => fetch(...a));

  async function apiGet(url) {
    if (!url.startsWith(API_BASE)) throw new Error('refusing to send API headers to ' + url);
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await doFetch(url, { headers });
    if (!r.ok) {
      const err = new Error('GitHub ' + r.status + ' for ' + url);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  return {
    async getUser(login) {
      return apiGet(API_BASE + 'users/' + encodeURIComponent(login));
    },
    async getRepos(login) {
      const url = API_BASE + 'users/' + encodeURIComponent(login) +
        '/repos?type=owner&per_page=100&sort=pushed';
      const list = await apiGet(url);
      return Array.isArray(list) ? list : [];
    },
    /* raw.githubusercontent.com never sees the token. */
    async getHubJson(login, repo, branch) {
      const url = RAW_BASE + encodeURIComponent(login) + '/' + encodeURIComponent(repo) +
        '/' + encodeURIComponent(branch || 'main') + '/hub.json';
      let r;
      try {
        r = await doFetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
      } catch (e) {
        return null;
      }
      if (!r.ok) return null;
      const text = await r.text();
      if (text.length > 20000) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }
  };
}

function safeAvatar(url, id) {
  if (typeof url === 'string' && url.startsWith('https://avatars.githubusercontent.com/')) return url;
  return 'https://avatars.githubusercontent.com/u/' + String(Number(id) || 0) + '?v=4';
}

function safeProfile(url, login) {
  if (typeof url === 'string' && url === 'https://github.com/' + login) return url;
  return 'https://github.com/' + login;
}

/* ---------- the build ---------- */

async function buildData(input) {
  const config = input.config || {};
  const owner = isValidLogin(config.owner) ? config.owner : 'StealPro101';
  const topic = clean(config.topic, 50).toLowerCase() || 'claude-hub-game';
  const maxGames = Number.isFinite(config.maxGamesPerMember) ? config.maxGamesPerMember : 20;
  const round = input.round || { round: 1, category: 'freestyle', note: '' };
  const roundCategory = clean(round.category, 40).toLowerCase();
  const blocked = blockedSets(input.blocked);
  const prev = input.prev && typeof input.prev === 'object' ? input.prev : null;
  const api = input.api;
  const log = input.log || (() => {});

  const prevGamesByOwner = new Map();
  const prevMembers = new Map();
  if (prev) {
    for (const g of Array.isArray(prev.games) ? prev.games : []) {
      if (!g || g.legacy || !isValidLogin(g.owner)) continue;
      const k = g.owner.toLowerCase();
      if (!prevGamesByOwner.has(k)) prevGamesByOwner.set(k, []);
      prevGamesByOwner.get(k).push(g);
    }
    for (const m of Array.isArray(prev.members) ? prev.members : []) {
      if (m && isValidLogin(m.login)) prevMembers.set(m.login.toLowerCase(), m);
    }
  }

  const rawMembers = Array.isArray(input.members && input.members.members)
    ? input.members.members : [];

  const members = [];
  const games = [];
  const errors = [];
  const seen = new Set();

  for (const entry of rawMembers) {
    if (!entry || !isValidLogin(entry.login)) {
      errors.push({ login: String(entry && entry.login), why: 'invalid login, skipped' });
      continue;
    }
    const login = entry.login;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (blocked.logins.has(key)) {
      log('blocked, skipped: ' + login);
      continue;
    }

    let user = null;
    let repos = null;
    try {
      user = await api.getUser(login);
      repos = await api.getRepos(login);
    } catch (e) {
      /* Fail safe: GitHub hiccup or rate limit must not wipe a member off the Hub. */
      errors.push({ login: login, why: e.message });
      log('API trouble for ' + login + ' (' + e.message + ') - keeping previous entries');
      const pm = prevMembers.get(key);
      if (pm) members.push(pm);
      for (const g of prevGamesByOwner.get(key) || []) games.push(g);
      continue;
    }

    if (!user || typeof user.id !== 'number' || !isValidLogin(user.login)) {
      errors.push({ login: login, why: 'unreadable user' });
      continue;
    }
    if (Number.isFinite(entry.id) && Number(entry.id) !== user.id) {
      /* The login was renamed or recycled: a different account must not inherit
         this member's profile or games. Drop it until the owner fixes the list. */
      errors.push({ login: login, why: 'id mismatch (expected ' + entry.id + ', got ' + user.id + ')' });
      log('id mismatch for ' + login + ' - dropped');
      continue;
    }

    const kept = filterRepos(repos, {
      topic: topic, blockedRepos: blocked.repos, max: maxGames, login: user.login
    });

    let count = 0;
    for (const r of kept) {
      const hub = await api.getHubJson(user.login, r.name, r.default_branch || 'main');
      const meta = normalizeHubJson(hub, {
        title: pretty(r.name),
        description: typeof r.description === 'string' ? r.description : '',
        roundCategory: roundCategory,
        seed: user.login + '/' + r.name
      });
      const url = playUrl(user.login, r.name);
      const rurl = repoUrl(user.login, r.name);
      if (!url || !rurl) continue;
      games.push({
        id: user.login + '/' + r.name,
        owner: user.login,
        title: meta.title,
        description: meta.description,
        category: meta.category,
        emoji: meta.emoji,
        url: url,
        repoUrl: rurl,
        stars: Number(r.stargazers_count) || 0,
        updated: typeof r.pushed_at === 'string' ? r.pushed_at : null
      });
      count++;
    }

    members.push({
      login: user.login,
      id: user.id,
      name: clean(user.name, 60) || user.login,
      avatar: safeAvatar(user.avatar_url, user.id),
      bio: clean(user.bio, MAX_DESC),
      url: safeProfile(user.html_url, user.login),
      joined: typeof entry.joined === 'string' ? clean(entry.joined, 20) : '',
      games: count
    });
  }

  /* The Hub's own games, so the old play links keep working. */
  const legacy = readLegacyGames(input.rootDir || process.cwd(), owner, roundCategory);
  const haveIds = new Set(games.map((g) => g.id.toLowerCase()));
  for (const g of legacy) {
    if (haveIds.has(g.id.toLowerCase())) continue;
    games.push(g);
    haveIds.add(g.id.toLowerCase());
    const m = members.find((x) => x.login.toLowerCase() === g.owner.toLowerCase());
    if (m) m.games += 1;
  }

  games.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) ||
    a.id.localeCompare(b.id));
  members.sort((a, b) => String(b.joined || '').localeCompare(String(a.joined || '')) ||
    a.login.localeCompare(b.login));

  if (errors.length && prev && Array.isArray(prev.games) && prev.games.length && !games.length) {
    throw new Error('refusing to write an empty Hub after API errors');
  }

  return {
    data: { v: 3, built: new Date().toISOString(), round: round, members: members, games: games },
    errors: errors
  };
}

/* Same content, ignoring only the build timestamp? */
function sameContent(a, b) {
  if (!a || !b) return false;
  const strip = (x) => {
    const c = Object.assign({}, x);
    delete c.built;
    return JSON.stringify(c);
  };
  return strip(a) === strip(b);
}

/* ---------- cli ---------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function parseArgs(argv) {
  const out = { emitChanged: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prev') out.prev = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--emit-changed') out.emitChanged = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || path.join(__dirname, '..'));
  const outFile = path.resolve(args.out || path.join(root, 'data', 'hub-data.json'));
  const prevFile = path.resolve(args.prev || outFile);

  const config = readJson(path.join(root, 'hub.config.json'), {});
  const membersFile = readJson(path.join(root, 'members.json'), { members: [] });
  const blocked = readJson(path.join(root, 'blocked.json'), { logins: [], repos: [] });
  const round = readJson(path.join(root, 'round.json'), { round: 1, category: 'freestyle', note: '' });
  const prev = readJson(prevFile, null);

  const token = process.env.GITHUB_TOKEN || '';
  const api = makeApi({ token: token });
  const log = (m) => console.log('  ' + m);

  console.log('Claude Hub indexer' + (token ? ' (with token)' : ' (no token)'));
  const result = await buildData({
    config: config, members: membersFile, blocked: blocked, round: round,
    prev: prev, api: api, rootDir: root, log: log
  });

  const changed = !sameContent(prev, result.data);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result.data, null, 2) + '\n');

  console.log('  members: ' + result.data.members.length + '  games: ' + result.data.games.length +
    '  changed: ' + changed);
  for (const e of result.errors) console.log('  ! ' + e.login + ': ' + e.why);
  console.log('  wrote ' + path.relative(root, outFile).split(path.sep).join('/'));

  if (args.emitChanged && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=' + (changed ? 'true' : 'false') + '\n');
  }
}

module.exports = {
  LOGIN_RE, REPO_RE, CATEGORIES, MAX_TITLE, MAX_DESC,
  graphemeCount, clean, pretty, iconFor, isValidLogin, isValidRepoName, isOkEmoji,
  allowedCategory, playUrl, repoUrl, normalizeHubJson, filterRepos, blockedSets,
  readLegacyGames, buildData, sameContent, makeApi, safeAvatar, safeProfile
};

if (require.main === module) {
  main().catch((e) => {
    console.error('indexer failed: ' + e.message);
    process.exit(1);
  });
}
