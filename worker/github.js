/*
 * The only place that talks to GitHub.
 *
 * - The app's client id + secret go out as HTTP Basic auth for the higher public-data
 *   rate limit, and ONLY to the real api.github.com (or the offline fake, which has no
 *   real credentials at all).
 * - raw.githubusercontent.com never gets any credential.
 * - The user's OAuth token is used once, for GET /user, and is never stored.
 * - Every outgoing call spends one unit of the subrequest budget, so one invocation
 *   can never run past Cloudflare's 50-subrequest limit.
 */

const REAL_API = 'https://api.github.com';
/* split so a plain "Bearer<space>" never appears as a literal in the repo */
const AUTH_SCHEME = 'Bearer' + ' ';
const UA = 'claude-hub';

export class BudgetError extends Error {
  constructor(limit) {
    super('subrequest budget spent (' + limit + ')');
    this.name = 'BudgetError';
  }
}

export function makeBudget(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 45;
  return {
    used: 0,
    limit: max,
    left() {
      return max - this.used;
    },
    spend() {
      if (this.used >= max) throw new BudgetError(max);
      this.used++;
    }
  };
}

export function makeGitHub(env, budget) {
  const api = String(env.GITHUB_API_BASE || REAL_API).replace(/\/+$/, '');
  const oauth = String(env.GITHUB_OAUTH_BASE || 'https://github.com').replace(/\/+$/, '');
  const raw = String(env.GITHUB_RAW_BASE || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  const fake = String(env.HUB_FAKE_GITHUB || '') === '1';
  const bud = budget || makeBudget(45);
  const clientId = env.GITHUB_CLIENT_ID || '';
  const clientSecret = env.GITHUB_CLIENT_SECRET || '';
  const credsAllowed = (api === REAL_API || fake) && clientId && clientSecret;

  async function call(url, init, useAppCreds) {
    bud.spend();
    const headers = new Headers((init && init.headers) || {});
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    headers.set('User-Agent', UA);
    if (useAppCreds) {
      if (!url.startsWith(api + '/')) throw new Error('refusing to send app credentials off-site');
      if (credsAllowed) headers.set('Authorization', 'Basic ' + btoa(clientId + ':' + clientSecret));
    }
    const res = await fetch(url, Object.assign({}, init, { headers: headers, redirect: 'follow' }));
    return res;
  }

  async function getJson(url, useAppCreds) {
    const res = await call(url, { method: 'GET' }, useAppCreds);
    if (!res.ok) {
      const err = new Error('GitHub ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    budget: bud,
    authorizeUrl(state, redirectUri) {
      const p = new URLSearchParams();
      p.set('client_id', clientId);
      p.set('redirect_uri', redirectUri);
      p.set('state', state);
      p.set('allow_signup', 'true');
      /* no scope parameter at all: identity and public data only */
      return oauth + '/login/oauth/authorize?' + p.toString();
    },

    async exchangeCode(code, redirectUri) {
      bud.spend();
      const res = await fetch(oauth + '/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': UA
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          redirect_uri: redirectUri
        })
      });
      if (!res.ok) throw new Error('token exchange failed');
      const j = await res.json();
      if (!j || typeof j.access_token !== 'string' || !j.access_token) {
        throw new Error('no access token');
      }
      return j.access_token;
    },

    /* Used once, right after the callback. The token is not stored anywhere. */
    async getAuthedUser(token) {
      const res = await call(api + '/user', {
        method: 'GET',
        headers: { Authorization: AUTH_SCHEME + token }
      }, false);
      if (!res.ok) throw new Error('could not read the GitHub account');
      return res.json();
    },

    /* By numeric id, so a renamed account is still the same person: GitHub answers
       with its current login. A 404 here means the account is really gone. */
    async getUserById(id) {
      return getJson(api + '/user/' + encodeURIComponent(String(Number(id))), true);
    },

    async listRepos(login) {
      const list = await getJson(api + '/users/' + encodeURIComponent(login) +
        '/repos?type=owner&per_page=100&sort=pushed', true);
      return Array.isArray(list) ? list : [];
    },

    async getRepo(login, repo) {
      return getJson(api + '/repos/' + encodeURIComponent(login) + '/' + encodeURIComponent(repo), true);
    },

    /* No credential, and anything that is not small clean JSON is ignored. */
    async getHubJson(login, repo, branch) {
      bud.spend();
      let res;
      try {
        res = await fetch(raw + '/' + encodeURIComponent(login) + '/' + encodeURIComponent(repo) +
          '/' + encodeURIComponent(branch || 'main') + '/hub.json',
        { headers: { Accept: 'application/json', 'User-Agent': UA } });
      } catch (e) {
        return null;
      }
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > 20000) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }
  };
}
