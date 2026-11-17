/*
 * Every string that comes from GitHub, from a member or from a request body is
 * untrusted. Nothing reaches storage or a page without passing through here.
 */

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const CODE_RE = /^[A-Z0-9]{4,16}$/;

export const MAX_TITLE = 60;
export const MAX_DESC = 200;
export const MAX_NAME = 60;

export const CATEGORIES = ['freestyle', 'arcade', 'action', 'puzzle', 'platformer', 'shooter',
  'racing', 'strategy', 'trivia', 'idle', 'horror', 'sandbox', 'sports', 'card', 'rhythm',
  'demo', 'other'];

const ICONS = ['\u{1F3AE}', '\u{1F47E}', '\u{1F579}️', '\u{1F680}', '\u{1F40D}', '\u{1F9E9}',
  '⚔️', '\u{1F3CE}️', '\u{1F6F8}', '\u{1F3AF}', '\u{1F409}', '\u{1F4A5}',
  '\u{1F3B2}', '\u{1F451}', '\u{1F9CA}', '\u{1F525}'];

export function clean(value, max) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max).trim();
  return s;
}

export function pretty(name) {
  return String(name || '').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function iconFor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ICONS[h % ICONS.length];
}

export function isLogin(v) {
  return typeof v === 'string' && LOGIN_RE.test(v);
}

export function isRepoName(v) {
  return typeof v === 'string' && REPO_RE.test(v) && v !== '.' && v !== '..';
}

export function isId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER;
}

export function graphemeCount(s) {
  const str = String(s);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    let n = 0;
    for (const _ of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str)) n++;
    return n;
  }
  return Array.from(str).length;
}

export function isOkEmoji(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/^[A-Za-z0-9]$/.test(s)) return false;
  return graphemeCount(s) === 1;
}

export function allowedCategory(value, extra) {
  const c = clean(value, 40).toLowerCase();
  if (!c) return null;
  if (CATEGORIES.includes(c)) return c;
  const e = clean(extra, 40).toLowerCase();
  if (e && c === e) return c;
  return null;
}

/* The play address is always computed from owner + repo. A member never supplies a
   URL, which is what makes "only things on your own account" true by construction. */
export function playUrl(login, repo) {
  if (!isLogin(login) || !isRepoName(repo)) return null;
  const host = login.toLowerCase() + '.github.io';
  if (repo.toLowerCase() === host) return 'https://' + host + '/';
  return 'https://' + host + '/' + repo + '/';
}

export function repoUrl(login, repo) {
  if (!isLogin(login) || !isRepoName(repo)) return null;
  return 'https://github.com/' + login + '/' + repo;
}

export function safeAvatar(url, id) {
  if (typeof url === 'string' && url.startsWith('https://avatars.githubusercontent.com/')
    && url.length < 300 && !/["'<>\s]/.test(url)) return url;
  return 'https://avatars.githubusercontent.com/u/' + (Number(id) || 0) + '?v=4';
}

export function safeProfile(login) {
  return isLogin(login) ? 'https://github.com/' + login : 'https://github.com';
}

/* hub.json is whatever the member wrote. Validate and cap every field. */
export function normalizeHubJson(raw, fallbacks) {
  const fb = fallbacks || {};
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    title: clean(obj.title, MAX_TITLE) || clean(fb.title, MAX_TITLE) || 'Untitled',
    description: clean(obj.description, MAX_DESC) || clean(fb.description, MAX_DESC) || '',
    category: allowedCategory(obj.category, fb.roundCategory) || 'freestyle',
    emoji: isOkEmoji(obj.emoji) ? obj.emoji.trim() : iconFor(fb.seed || obj.title || 'game')
  };
}

/*
 * A repo may be on the Hub only if it is public, owned (not a fork), alive and has
 * Pages on. The topic is NOT required here - it only drives automatic adding.
 */
export function repoEligible(repo, ownerId) {
  if (!repo || typeof repo !== 'object') return false;
  if (!isRepoName(repo.name)) return false;
  const owner = repo.owner || {};
  if (!isLogin(owner.login)) return false;
  if (ownerId != null && Number(owner.id) !== Number(ownerId)) return false;
  if (repo.private === true) return false;
  if (repo.fork === true) return false;
  if (repo.archived === true) return false;
  if (repo.disabled === true) return false;
  if (repo.has_pages !== true) return false;
  return true;
}

export function repoTopics(repo) {
  return Array.isArray(repo && repo.topics)
    ? repo.topics.filter((t) => typeof t === 'string').map((t) => t.toLowerCase())
    : [];
}

export function hasTopic(repo, topic) {
  return repoTopics(repo).includes(String(topic || '').toLowerCase());
}

export function gameKey(ownerId, repo) {
  return 'game:' + Number(ownerId) + '/' + repo;
}

export function tombKey(ownerId, repo) {
  return 'tomb:' + Number(ownerId) + '/' + repo;
}
