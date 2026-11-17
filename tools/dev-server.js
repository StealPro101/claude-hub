#!/usr/bin/env node
/*
 * Runs the whole Hub offline, on http://127.0.0.1:8797
 *
 *   node tools/dev-server.js            keeps the store in .tmp-test/dev-store.json
 *   node tools/dev-server.js --reset    starts from an empty store
 *
 * Nothing is downloaded and no real GitHub account is touched: GitHub itself is faked
 * (tools/fake-github.js), so sign in -> add a game -> play -> admin all work here.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileStore } from './file-store.js';
import { fakeState, fakeFetch, fakeGitHub, fakeEnv } from './fake-github.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PUBLIC = path.join(root, 'public');
const PORT = Number(process.env.PORT || 8797);
const HOST = '127.0.0.1';
const ORIGIN = 'http://' + HOST + ':' + PORT;
const GH_PREFIX = '/__gh';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

/* The assets binding, straight off disk. Never serves outside public/. */
export function diskAssets(dir) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel.includes('\0') || rel.includes('..')) return new Response('no', { status: 400 });
      if (rel.endsWith('/')) rel += 'index.html';
      let file = path.join(dir, rel);
      if (!path.resolve(file).startsWith(path.resolve(dir))) {
        return new Response('no', { status: 400 });
      }
      let body = null;
      try {
        body = fs.readFileSync(file);
      } catch (e) {
        try {
          const alt = path.join(dir, rel, 'index.html');
          if (path.resolve(alt).startsWith(path.resolve(dir))) {
            body = fs.readFileSync(alt);
            file = alt;
          }
        } catch (e2) {
          body = null;
        }
      }
      if (!body) {
        let nf = '<!DOCTYPE html><title>404</title>not found';
        try {
          nf = fs.readFileSync(path.join(dir, '404.html'));
        } catch (e) { /* plain text then */ }
        return new Response(nf, {
          status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        }
      });
    }
  };
}

export function devEnv(store, origin) {
  const base = (origin || ORIGIN) + GH_PREFIX;
  /* any HUB_* from the shell wins, so a fixture run can switch things off */
  const fromShell = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HUB_') && v) fromShell[k] = v;
  }
  return Object.assign(fakeEnv({
    HUB_STORE: store,
    ASSETS: diskAssets(PUBLIC),
    GITHUB_OAUTH_BASE: base,
    GITHUB_API_BASE: base + '/api',
    GITHUB_RAW_BASE: base + '/raw'
  }), fromShell);
}

/* Server side GitHub calls are answered in process - no loopback, no internet. */
export function patchFetch(state, origin) {
  const prefix = (origin || ORIGIN) + GH_PREFIX;
  const real = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(prefix)) {
      const u = new URL(url);
      const p = u.pathname.slice(GH_PREFIX.length) || '/';
      const headers = init && init.headers ? new Headers(init.headers) : new Headers();
      return fakeGitHub(state, p, u.searchParams, Object.assign({}, init, { headers: headers }));
    }
    throw new Error('the dev server does not reach the internet: ' + url);
  };
  return () => {
    globalThis.fetch = real;
  };
}

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : null;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  return new Request(ORIGIN + req.url, {
    method: req.method,
    headers: headers,
    body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined
  });
}

async function send(res, response) {
  const headers = {};
  const cookies = [];
  response.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') cookies.push(v);
    else headers[k] = v;
  });
  if (typeof response.headers.getSetCookie === 'function') {
    const all = response.headers.getSetCookie();
    if (all.length) {
      cookies.length = 0;
      for (const c of all) cookies.push(c);
    }
  }
  if (cookies.length) headers['Set-Cookie'] = cookies;
  const buf = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(buf);
}

export async function startDevServer(opts) {
  const o = opts || {};
  const storeFile = o.storeFile || path.join(root, '.tmp-test', 'dev-store.json');
  const store = fileStore(storeFile);
  if (o.reset) store.reset();
  const state = o.state || fakeState();
  patchFetch(state, ORIGIN);
  const env = devEnv(store, ORIGIN);
  /* a fixture can pre-fill who is playing what, so screenshots show real dots */
  try {
    const seed = JSON.parse(process.env.HUB_SEED_PRESENCE || '[]');
    const beat = () => {
      for (const row of seed) {
        env.PRESENCE.core.beat(row.who || null, row.token || null, row.game || null);
        if (row.visits) env.PRESENCE.core.visits.set(row.game, row.visits);
      }
    };
    beat();
    /* keep them alive, or they time out after 90 seconds mid-screenshot */
    if (seed.length) setInterval(beat, 30000).unref();
  } catch (e) { /* no seeded presence */ }
  const worker = await import('../worker/index.js');

  const server = http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      const url = new URL(request.url);
      if (url.pathname === GH_PREFIX || url.pathname.startsWith(GH_PREFIX + '/')) {
        const p = url.pathname.slice(GH_PREFIX.length) || '/';
        const r = await fakeGitHub(state, p, url.searchParams, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'POST' ? await request.text() : undefined
        });
        await send(res, r);
        return;
      }
      const out = await worker.handle(request, env, { waitUntil() {} });
      await send(res, out);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('dev server error: ' + (e && e.message));
    }
  });

  await new Promise((done) => server.listen(PORT, HOST, done));
  return { server, store, state, env, origin: ORIGIN };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const reset = process.argv.includes('--reset');
  startDevServer({ reset: reset }).then((d) => {
    console.log('Claude Hub dev server on ' + d.origin);
    console.log('  store: ' + d.store.file + (reset ? ' (reset)' : ''));
    console.log('  fake GitHub at ' + d.origin + GH_PREFIX + '/login/oauth/authorize');
    console.log('  admin id 9001 = sp101-admin, friends: friend-one, friend-two, stranger, banned-bob');
  });
}
