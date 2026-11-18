#!/usr/bin/env node
/*
 * Fills the local dev store with a made-up Hub, so the look of the site can be judged
 * at 0, 1, 9 and 40 games without touching anything real.
 *
 *   node tools/seed-fixture.js 9        nine published games, most with covers
 *   node tools/seed-fixture.js 0        the empty shelf
 *   node tools/seed-fixture.js 40       a shelf that has to scroll
 *
 * The cover pictures are written here as real PNGs (a tiny encoder below, using the
 * zlib that ships with node) - nothing is downloaded.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.join(root, '.tmp-test', 'dev-store.json');

/* ---------- the smallest PNG encoder that still makes a real picture ---------- */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcBuf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const rgb = pixel(x / width, y / height);
      raw[p++] = rgb[0];
      raw[p++] = rgb[1];
      raw[p++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* a flat ground, a sun and a horizon: enough to read as a real cover at card size */
export function coverPng(seed) {
  const pairs = [
    [[26, 48, 44], [228, 242, 230], [255, 132, 72]],
    [[42, 29, 61], [239, 228, 255], [255, 108, 180]],
    [[58, 30, 26], [255, 227, 212], [255, 186, 92]],
    [[16, 38, 59], [220, 235, 255], [120, 200, 255]],
    [[46, 42, 20], [245, 237, 201], [240, 200, 80]],
    [[51, 27, 43], [255, 218, 237], [255, 120, 150]],
    [[18, 48, 40], [214, 255, 233], [90, 230, 170]],
    [[38, 38, 38], [240, 239, 237], [255, 106, 43]],
    [[58, 36, 16], [255, 233, 202], [255, 160, 60]],
    [[21, 30, 60], [221, 227, 255], [140, 150, 255]]
  ];
  const p = pairs[seed % pairs.length];
  const sunX = 0.3 + ((seed * 7) % 5) * 0.1;
  const horizon = 0.58 + ((seed * 3) % 4) * 0.05;
  return png(480, 300, (u, v) => {
    if (v > horizon) {
      const t = (v - horizon) / (1 - horizon);
      return [
        Math.round(p[0][0] + t * 26),
        Math.round(p[0][1] + t * 26),
        Math.round(p[0][2] + t * 26)
      ];
    }
    const dx = (u - sunX) * 1.6;
    const dy = v - horizon * 0.55;
    if (dx * dx + dy * dy < 0.028) return p[2];
    const t = v / horizon;
    return [
      Math.round(p[0][0] * (1 - t * 0.45) + p[1][0] * t * 0.3),
      Math.round(p[0][1] * (1 - t * 0.45) + p[1][1] * t * 0.3),
      Math.round(p[0][2] * (1 - t * 0.45) + p[1][2] * t * 0.3)
    ];
  });
}

/* ---------- the made-up Hub ---------- */

const NAMES = [
  ['Tunnel Mouse', 'arcade', 'Run the pipes, do not meet the cat.'],
  ['Six Lanterns', 'puzzle', 'Light them in the right order and the door opens.'],
  ['Cold Open', 'horror', 'A hallway. A torch with eleven seconds of battery.'],
  ['Pocket Derby', 'racing', 'Four laps, one thumb, no brakes.'],
  ['Marrow', 'platformer', 'Jump, cling, fall, say one more go.'],
  ['Quiet Robots', 'strategy', 'Give the orders, then watch them go wrong.'],
  ['Night Market', 'idle', 'Sell noodles until the sun comes up.'],
  ['Sixty Questions', 'trivia', 'One minute. Sixty things you half remember.'],
  ['Paper Fleet', 'sandbox', 'Fold a boat, sink a friend.'],
  ['Ember Lane', 'action', 'Everything is on fire and you are late.']
];

const MEMBERS = [
  { id: 7001, login: 'friend-one', name: 'Ada' },
  { id: 7002, login: 'friend-two', name: 'Bea' },
  { id: 9001, login: 'sp101-admin', name: 'The Owner' }
];

function build(count) {
  const state = { v: 5, members: {}, games: {}, house: {}, bans: {}, tombs: {}, settings: null };
  const blobs = {};
  const favorites = {};

  state.settings = {
    round: { round: 3, category: 'horror', note: 'make something that makes us jump' },
    inviteRequired: true,
    inviteCode: 'FIXTURE1',
    rotation: 0,
    lastRefresh: new Date().toISOString(),
    log: [{ at: new Date().toISOString(), what: 'fixture', who: 'test', detail: count + ' games' }]
  };

  for (const m of MEMBERS) {
    state.members[String(m.id)] = {
      id: m.id,
      login: m.login,
      name: m.name,
      avatar: 'https://avatars.githubusercontent.com/u/' + m.id + '?v=4',
      bio: m.id === 7001 ? 'makes small games on the bus' : '',
      url: 'https://github.com/' + m.login,
      joined: '2026-11-0' + (MEMBERS.indexOf(m) + 1),
      seen: '2026-11-16',
      lastSeen: m.id === 7002 ? new Date(Date.now() - 3 * 3600000).toISOString() : null,
      /* a private list each, newest first - filled in below once the games exist */
      favorites: []
    };
    favorites[m.id] = [];
  }

  for (let i = 0; i < count; i++) {
    const m = MEMBERS[i % MEMBERS.length];
    const n = NAMES[i % NAMES.length];
    const suffix = i >= NAMES.length ? ' ' + (Math.floor(i / NAMES.length) + 1) : '';
    const repo = (n[0] + suffix).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
    const withCover = i % 4 !== 3;
    const bytes = withCover ? coverPng(i) : null;
    /* the owner and one friend keep a few private favourites, as a real hub would */
    if (i % 3 === 1) favorites[9001].unshift(m.login + '/' + repo);
    if (i % 4 === 0) favorites[7001].unshift(m.login + '/' + repo);
    state.games[m.id + '/' + repo] = {
      id: m.login + '/' + repo,
      ownerId: m.id,
      owner: m.login,
      repo: repo,
      title: n[0] + suffix,
      description: n[2],
      howto: i % 2 === 0 ? ['Arrows to move.', 'Space to jump.', '', 'Press P to pause.'].join('\n') : '',
      notes: i % 3 === 0 ? ['Made in a weekend.', 'Sounds by a friend.'].join('\n') : '',
      category: n[1],
      emoji: '',
      url: 'https://' + m.login + '.github.io/' + repo + '/',
      repoUrl: 'https://github.com/' + m.login + '/' + repo,
      stars: (i * 3) % 7,
      updated: new Date(Date.now() - i * 86400000 * 1.7).toISOString(),
      added: '2026-11-01T00:00:00Z',
      source: i % 3 === 0 ? 'topic' : 'manual',
      status: 'published',
      locked: true,
      cover: bytes ? { v: 'fx' + i, type: 'image/png' } : null,
      hidden: false,
      featured: i === 1,
      metaAt: '2026-11-16T00:00:00Z'
    };
    if (bytes) blobs['cover:' + m.id + '/' + repo] = { type: 'image/png', b64: bytes.toString('base64') };
  }

  for (const id of Object.keys(favorites)) {
    if (state.members[id]) state.members[id].favorites = favorites[id].slice(0, 100);
  }

  return { data: { state: JSON.stringify(state) }, blobs: blobs, state: state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const count = Number(process.argv[2] || 9);
  const { data, blobs } = build(count);
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
  fs.writeFileSync(STORE.replace(/\.json$/, '') + '-blobs.json', JSON.stringify(blobs));
  /* a picture for the browser check to upload through the real file input */
  fs.writeFileSync(path.join(root, '.tmp-test', 'upload.png'), coverPng(3));
  console.log('fixture written: ' + count + ' games, ' +
    Object.keys(blobs).length + ' covers -> ' + STORE);
}
