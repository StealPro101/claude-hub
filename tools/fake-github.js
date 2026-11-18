import { fakePresence } from './fake-presence.js';
/*
 * A fake GitHub, so the whole sign-in -> add game -> play -> admin flow runs offline
 * with nothing downloaded and no real account touched.
 *
 * It answers the same shapes the real API does for the handful of calls the Worker
 * makes. Used two ways:
 *   - as a patched global fetch, for the Worker's own server side calls and the tests
 *   - over http at /__gh/..., so a browser can press the fake "authorize" button
 */

export const FAKE_USERS = {
  'sp101-admin': {
    login: 'sp101-admin', id: 9001, name: 'The Owner', bio: 'runs the hub',
    avatar_url: 'https://avatars.githubusercontent.com/u/9001?v=4',
    html_url: 'https://github.com/sp101-admin'
  },
  'friend-one': {
    login: 'friend-one', id: 7001, name: 'Friend One <img src=x onerror=alert(1)>',
    bio: 'bio with <script>alert(2)</script> in it',
    avatar_url: 'https://avatars.githubusercontent.com/u/7001?v=4',
    html_url: 'https://github.com/friend-one'
  },
  'friend-two': {
    login: 'friend-two', id: 7002, name: 'Friend Two', bio: 'second friend',
    avatar_url: 'https://avatars.githubusercontent.com/u/7002?v=4',
    html_url: 'https://github.com/friend-two'
  },
  stranger: {
    login: 'stranger', id: 7003, name: 'Random Stranger', bio: '',
    avatar_url: 'https://avatars.githubusercontent.com/u/7003?v=4',
    html_url: 'https://github.com/stranger'
  },
  'banned-bob': {
    login: 'banned-bob', id: 7004, name: 'Bob', bio: '',
    avatar_url: 'https://avatars.githubusercontent.com/u/7004?v=4',
    html_url: 'https://github.com/banned-bob'
  }
};

function repo(owner, name, extra) {
  return Object.assign({
    name: name,
    owner: { login: owner.login, id: owner.id },
    private: false,
    fork: false,
    archived: false,
    disabled: false,
    has_pages: true,
    topics: [],
    default_branch: 'main',
    description: '',
    stargazers_count: 0,
    pushed_at: '2026-11-01T10:00:00Z'
  }, extra || {});
}

const TOPIC = ['claude-hub-game'];

export const FAKE_REPOS = {
  'friend-one': [
    repo(FAKE_USERS['friend-one'], 'snake-dash', {
      topics: TOPIC, description: 'a snake that dashes', stargazers_count: 3,
      pushed_at: '2026-11-14T09:00:00Z'
    }),
    repo(FAKE_USERS['friend-one'], 'xss-game', {
      topics: TOPIC, description: 'desc <b>bold</b>', pushed_at: '2026-11-13T09:00:00Z'
    }),
    repo(FAKE_USERS['friend-one'], 'plain-game', {
      description: 'no topic yet', pushed_at: '2026-11-12T09:00:00Z'
    }),
    repo(FAKE_USERS['friend-one'], 'no-pages', { topics: TOPIC, has_pages: false }),
    repo(FAKE_USERS['friend-one'], 'forked-thing', { topics: TOPIC, fork: true }),
    repo(FAKE_USERS['friend-one'], 'secret-lab', { topics: TOPIC, private: true }),
    repo(FAKE_USERS['friend-one'], 'old-stuff', { topics: TOPIC, archived: true })
  ],
  'friend-two': [
    repo(FAKE_USERS['friend-two'], 'friend-two.github.io', {
      topics: TOPIC, description: 'my home page game', pushed_at: '2026-11-15T09:00:00Z'
    }),
    repo(FAKE_USERS['friend-two'], 'tiny-puzzle', {
      description: 'small puzzle', pushed_at: '2026-11-10T09:00:00Z'
    })
  ],
  'sp101-admin': [
    repo(FAKE_USERS['sp101-admin'], 'owner-game', {
      topics: TOPIC, description: 'the house game', pushed_at: '2026-11-16T09:00:00Z'
    }),
    /* the Hub itself: public, Pages on (that is how the house games are served) and
       even carrying the topic - it must still never be addable as a game */
    repo(FAKE_USERS['sp101-admin'], 'claude-hub', {
      topics: TOPIC, description: 'the Hub we are all playing on',
      pushed_at: '2026-11-17T09:00:00Z'
    })
  ],
  stranger: [],
  'banned-bob': []
};

export const FAKE_HUB_JSON = {
  'friend-one/snake-dash': {
    title: 'Snake Dash', description: 'Eat, grow, do not hit the wall.',
    category: 'arcade', emoji: '\u{1F40D}'
  },
  'friend-one/xss-game': {
    title: '<img src=x onerror=alert(1)>',
    description: 'click <a href="javascript:alert(3)">here</a> for prizes',
    category: '<script>alert(4)</script>',
    emoji: '<svg onload=alert(5)>'
  },
  'friend-two/friend-two.github.io': {
    title: 'Home Run', description: 'lives at the root of my pages site',
    category: 'sports', emoji: '⚾'
  }
};

/* Each world gets its own copy, so a test that renames or deletes a fake account
   cannot leak into the next one. */
export function fakeState(overrides) {
  return Object.assign({
    users: structuredClone(FAKE_USERS),
    repos: structuredClone(FAKE_REPOS),
    hubJson: structuredClone(FAKE_HUB_JSON),
    /* flip to make every API call fail, to prove nothing is lost */
    broken: false,
    calls: 0
  }, overrides || {});
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/*
 * Handles one fake GitHub call. `path` is everything after the fake base, e.g.
 * /api/users/friend-one/repos or /login/oauth/authorize.
 */
export async function fakeGitHub(state, path, search, init) {
  state.calls++;
  const method = ((init && init.method) || 'GET').toUpperCase();

  if (path === '/login/oauth/authorize') {
    const redirect = search.get('redirect_uri') || '/auth/callback';
    const st = search.get('state') || '';
    const rows = Object.keys(state.users).map((login) =>
      '<p class="mt-s"><a class="btn" href="' +
      esc(redirect + (redirect.includes('?') ? '&' : '?') + 'code=fake-' + login +
        '&state=' + encodeURIComponent(st)) +
      '" id="as-' + esc(login) + '">sign in as ' + esc(login) + '</a></p>').join('');
    return new Response('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>Fake GitHub</title><link rel="stylesheet" href="/assets/hub.css"></head><body>' +
      '<div class="wrap"><h1 class="logo">FAKE GITHUB</h1>' +
      '<div class="panel"><h2>WHO ARE YOU PRETENDING TO BE?</h2>' + rows + '</div></div>' +
      '</body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (path === '/login/oauth/access_token') {
    if (method !== 'POST') return json({ error: 'post only' }, 405);
    let body = {};
    try {
      body = JSON.parse((init && init.body) || '{}');
    } catch (e) {
      body = {};
    }
    const code = String(body.code || '');
    const login = code.startsWith('fake-') ? code.slice(5) : '';
    if (!state.users[login]) return json({ error: 'bad_verification_code' }, 200);
    return json({ access_token: 'token-' + login, token_type: 'bearer', scope: '' });
  }

  if (state.broken) return json({ message: 'fake outage' }, 503);

  if (path === '/api/user') {
    const auth = ((init && init.headers && (init.headers.get
      ? init.headers.get('Authorization') : init.headers.Authorization)) || '');
    const scheme = 'Bearer' + ' ';
    const login = auth.startsWith(scheme + 'token-') ? auth.slice(scheme.length + 6) : '';
    const user = state.users[login];
    if (!user) return json({ message: 'Bad credentials' }, 401);
    return json(user);
  }

  /* by numeric id - the real API answers with the account's current login */
  let m = path.match(/^\/api\/user\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const found = Object.values(state.users).find((u) => Number(u.id) === id);
    return found ? json(found) : json({ message: 'Not Found' }, 404);
  }

  m = path.match(/^\/api\/users\/([^/]+)\/repos$/);
  if (m) {
    const login = decodeURIComponent(m[1]);
    if (!state.users[login]) return json({ message: 'Not Found' }, 404);
    return json(state.repos[login] || []);
  }

  m = path.match(/^\/api\/users\/([^/]+)$/);
  if (m) {
    const user = state.users[decodeURIComponent(m[1])];
    return user ? json(user) : json({ message: 'Not Found' }, 404);
  }

  m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)$/);
  if (m) {
    const login = decodeURIComponent(m[1]);
    const name = decodeURIComponent(m[2]);
    const list = state.repos[login] || [];
    const found = list.find((r) => r.name.toLowerCase() === name.toLowerCase());
    return found ? json(found) : json({ message: 'Not Found' }, 404);
  }

  m = path.match(/^\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/hub\.json$/);
  if (m) {
    const key = decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]);
    const hub = state.hubJson[key];
    if (!hub) return new Response('404', { status: 404 });
    return new Response(JSON.stringify(hub), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return json({ message: 'fake GitHub has no ' + path }, 404);
}

export const FAKE_BASE = {
  api: 'http://fake.github/api',
  oauth: 'http://fake.github',
  raw: 'http://fake.github/raw'
};

/*
 * Returns a fetch replacement: fake GitHub URLs are answered in process, anything
 * else is refused loudly so a test can never reach the real internet.
 */
export function fakeFetch(state, bases) {
  const b = bases || FAKE_BASE;
  const roots = [b.api, b.oauth, b.raw].map((x) => x.replace(/\/+$/, ''));
  const root = roots.reduce((a, c) => (c.length < a.length ? c : a), roots[0]);
  return async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(root)) {
      throw new Error('test tried to reach the real internet: ' + url);
    }
    const u = new URL(url);
    const path = u.pathname.replace(/^\/+/, '/');
    const inner = init && init.headers && !(init.headers.get)
      ? Object.assign({}, init, { headers: new Headers(init.headers) })
      : init;
    return fakeGitHub(state, path, u.searchParams, inner);
  };
}

export function fakeEnv(extra) {
  return Object.assign({
    PRESENCE: fakePresence(),
    GITHUB_CLIENT_ID: 'fake-client-id',
    GITHUB_CLIENT_SECRET: 'fake-client-secret',
    SESSION_SECRET: 'test-session-secret-0123456789',
    ADMIN_GITHUB_IDS: '9001',
    HUB_TOPIC: 'claude-hub-game',
    HUB_FAKE_GITHUB: '1',
    HUB_INSECURE_COOKIES: '1',
    HUB_NO_CACHE: '1',
    GITHUB_API_BASE: FAKE_BASE.api,
    GITHUB_OAUTH_BASE: FAKE_BASE.oauth,
    GITHUB_RAW_BASE: FAKE_BASE.raw
  }, extra || {});
}
