/*
 * Sign in with GitHub - identity only, no scopes requested.
 *
 * /auth/login     makes a random state, remembers it (plus the invite code) in a
 *                 short-lived signed HttpOnly cookie, sends the friend to GitHub
 * /auth/callback  checks the state, trades the code for a token, reads /user once,
 *                 throws the token away, and sets the session cookie
 * /auth/logout    clears the session
 */

import { pack, unpack, cookie, parseCookies, randomToken, json, today } from './util.js';
import { CODE_RE, isId, isLogin } from './validate.js';
import { makeGitHub, makeBudget } from './github.js';
import { getSettings, getMember, isBanned, memberRecord, isAdminId, addLog } from './hub.js';

export const SESSION_COOKIE = 'hub_session';
export const STATE_COOKIE = 'hub_oauth';
const SESSION_DAYS = 30;

function secretOf(env) {
  const s = env && env.SESSION_SECRET;
  return typeof s === 'string' && s.length >= 16 ? s : null;
}

export async function readSession(request, env) {
  const secret = secretOf(env);
  if (!secret) return null;
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const payload = await unpack(secret, token);
  if (!payload || !isId(payload.id) || !isLogin(payload.login)) return null;
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 < Date.now()) return null;
  return { id: Number(payload.id), login: payload.login, exp: payload.exp };
}

export async function sessionCookieFor(env, user) {
  const secret = secretOf(env);
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const token = await pack(secret, { id: Number(user.id), login: user.login, exp: exp });
  return cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, secure: env.HUB_INSECURE_COOKIES !== '1' });
}

function redirect(to, headers) {
  const h = new Headers(headers || {});
  h.set('Location', to);
  h.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers: h });
}

function page(title, lines, status) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const body = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + ' - Claude Hub</title><link rel="stylesheet" href="/assets/hub.css"></head>' +
    '<body><div class="wrap"><h1 class="logo">CLAUDE HUB</h1><div class="panel" style="margin-top:24px">' +
    '<h2>' + esc(title) + '</h2>' +
    lines.map((l) => '<p class="mini" style="margin-top:10px">' + esc(l) + '</p>').join('') +
    '<p style="margin-top:18px"><a class="btn alt" href="/">back to the arcade</a></p>' +
    '</div></div></body></html>';
  return new Response(body, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function handleLogin(request, env) {
  if (!secretOf(env)) return page('Not set up yet', ['SESSION_SECRET is missing, so signing in is switched off.'], 503);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return page('Not set up yet', ['The GitHub app details are missing, so signing in is switched off.'], 503);
  }
  const url = new URL(request.url);
  const raw = (url.searchParams.get('code') || '').trim().toUpperCase();
  const invite = CODE_RE.test(raw) ? raw : '';
  const state = randomToken(18);
  const token = await pack(secretOf(env), {
    state: state, invite: invite, exp: Math.floor(Date.now() / 1000) + 600
  });
  const gh = makeGitHub(env, makeBudget(4));
  const to = gh.authorizeUrl(state, url.origin + '/auth/callback');
  return redirect(to, {
    'Set-Cookie': cookie(STATE_COOKIE, token, {
      maxAge: 600, secure: env.HUB_INSECURE_COOKIES !== '1'
    })
  });
}

export async function handleCallback(request, env, store) {
  const secret = secretOf(env);
  if (!secret) return page('Not set up yet', ['SESSION_SECRET is missing.'], 503);
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  const state = (url.searchParams.get('state') || '').trim();
  const clear = cookie(STATE_COOKIE, '', { maxAge: 0, secure: env.HUB_INSECURE_COOKIES !== '1' });

  const saved = await unpack(secret, parseCookies(request)[STATE_COOKIE] || '');
  if (!saved || !saved.state || !Number.isFinite(saved.exp) || saved.exp * 1000 < Date.now()) {
    return page('That sign-in expired', ['Start again from the Hub and it will work.'], 400);
  }
  if (!state || state !== saved.state) {
    return page('Sign-in blocked', ['The one-time check did not match, so nothing was done.'], 400);
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(code)) {
    return page('Sign-in blocked', ['GitHub did not send a usable code.'], 400);
  }

  const gh = makeGitHub(env, makeBudget(6));
  let user;
  try {
    const token = await gh.exchangeCode(code, url.origin + '/auth/callback');
    user = await gh.getAuthedUser(token);
    /* the token is deliberately not stored anywhere */
  } catch (e) {
    return page('GitHub said no', ['Signing in did not go through. Try again in a minute.'], 502);
  }
  if (!user || !isId(user.id) || !isLogin(user.login)) {
    return page('Sign-in blocked', ['That account could not be read.'], 400);
  }

  if (await isBanned(store, user.id)) {
    return page('Not allowed', ['This account cannot use the Hub.'], 403);
  }

  const admin = isAdminId(env, user.id);
  const settings = await getSettings(store, env);
  const existing = await getMember(store, user.id);

  if (!existing && !admin && settings.inviteRequired) {
    const ok = typeof saved.invite === 'string' && saved.invite &&
      saved.invite === String(settings.inviteCode || '').toUpperCase();
    if (!ok) {
      return page('Invite only', [
        'The Hub is just for friends, so you need the join link.',
        'Ask for the link that ends in /join?code=... and press Sign in with GitHub from there.'
      ], 403);
    }
  }

  const record = existing
    ? Object.assign({}, existing, memberRecord(user, existing.joined), { joined: existing.joined })
    : memberRecord(user, today());
  await store.put('member:' + Number(user.id), record);
  if (!existing) {
    await addLog(store, { what: 'joined', who: user.login, detail: admin ? 'admin' : 'invite' });
  }

  const setCookie = await sessionCookieFor(env, user);
  const headers = new Headers();
  headers.append('Set-Cookie', setCookie);
  headers.append('Set-Cookie', clear);
  headers.set('Location', existing ? '/' : '/mygames.html');
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers: headers });
}

export async function handleLogout(request, env) {
  const headers = new Headers();
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', {
    maxAge: 0, secure: env.HUB_INSECURE_COOKIES !== '1'
  }));
  return json({ ok: true }, 200, headers);
}
