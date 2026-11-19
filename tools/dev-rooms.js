/*
 * Rooms in the dev server, with node's own modules and nothing installed.
 *
 * Cloudflare does the WebSocket part for us on the real site; offline there is nobody
 * to do it, so this is the smallest thing that counts as a server: the handshake, a
 * frame reader, a frame writer, and sockets that look enough like the Durable Object's
 * (send, close, serializeAttachment, deserializeAttachment, readyState) for the real
 * RoomsCore to run on them unchanged.
 *
 * It is only ever the dev server. Nothing here is deployed, and the Worker's own
 * checks (origin, code, player id, name) still run first, through worker.handle().
 */
import crypto from 'node:crypto';
import { RoomsCore } from '../worker/rooms.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------- frames ---------- */

function textFrame(text) {
  const body = Buffer.from(String(text), 'utf8');
  const n = body.length;
  let head;
  if (n < 126) {
    head = Buffer.from([0x81, n]);
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, body]);
}

function closeFrame(code, reason) {
  const text = Buffer.from(String(reason || '').slice(0, 100), 'utf8');
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(Number(code) || 1000, 0);
  text.copy(body, 2);
  return Buffer.concat([Buffer.from([0x88, body.length]), body]);
}

/* One frame off the front of the buffer, or null when there is not a whole one yet. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const mask = masked ? buf.slice(at, at + 4) : null;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const body = Buffer.from(buf.slice(at, at + len));
  if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return { opcode: opcode, body: body, rest: buf.slice(at + len) };
}

/* ---------- a socket the core can talk to ---------- */

function devSocket(raw) {
  return {
    readyState: 1,
    tags: [],
    att: null,
    send(line) {
      if (this.readyState !== 1) throw new Error('that socket is closed');
      raw.write(textFrame(line));
    },
    close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      try {
        raw.write(closeFrame(code, reason));
      } catch (e) { /* already gone */ }
      try {
        raw.end();
      } catch (e) { /* already gone */ }
    },
    serializeAttachment(value) {
      this.att = JSON.parse(JSON.stringify(value));
    },
    deserializeAttachment() {
      return this.att === null ? null : JSON.parse(JSON.stringify(this.att));
    }
  };
}

/* ---------- the object's socket side ---------- */

export function devRooms(storage) {
  const list = [];
  const core = new RoomsCore({
    storage: storage,
    now: () => Date.now(),
    accept: (ws, tags) => {
      ws.tags = (tags || []).slice();
      if (list.indexOf(ws) < 0) list.push(ws);
    },
    sockets: (tag) => (tag === undefined ? list.slice()
      : list.filter((ws) => ws.tags.indexOf(tag) >= 0))
  });

  /* Hands the raw TCP socket to the core, once the Worker has said it may. */
  async function open(raw, key, params) {
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    raw.write('HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const ws = devSocket(raw);
    let buf = Buffer.alloc(0);
    let shut = false;
    const gone = async () => {
      if (shut) return;
      shut = true;
      ws.readyState = 3;
      const at = list.indexOf(ws);
      if (at >= 0) list.splice(at, 1);
      await core.close(ws, 1006, '', false);
    };
    raw.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = readFrame(buf);
        if (!frame) return;
        buf = frame.rest;
        if (frame.opcode === 8) {
          ws.close(1000, 'bye');
          await gone();
          return;
        }
        if (frame.opcode === 9) {
          raw.write(Buffer.concat([Buffer.from([0x8a, frame.body.length]), frame.body]));
          continue;
        }
        if (frame.opcode === 1 || frame.opcode === 0) {
          await core.message(ws, frame.body.toString('utf8'));
        }
      }
    });
    raw.on('close', gone);
    raw.on('error', gone);
    await core.connect(ws, params);
    if (ws.readyState === 3) await gone();
    return ws;
  }

  return { core: core, open: open, sockets: list };
}

/*
 * The PRESENCE binding's "rooms" instance for the dev server. The Worker fetches it
 * exactly as it does on Cloudflare; the raw socket is handed over on the side, because
 * a node Request cannot carry one.
 */
export function devRoomsBinding(presence, storage) {
  const rooms = devRooms(storage);
  const waiting = { raw: null, key: '', taken: false };
  const stub = {
    async fetch(url, init) {
      const headers = new Headers((init && init.headers) || (url && url.headers) || {});
      const href = typeof url === 'string' ? url : url.url;
      const u = new URL(href);
      if ((headers.get('Upgrade') || '').toLowerCase() === 'websocket' && waiting.raw) {
        const raw = waiting.raw;
        const key = waiting.key;
        waiting.raw = null;
        waiting.taken = true;
        await rooms.open(raw, key, {
          game: u.searchParams.get('game') || '',
          way: u.searchParams.get('want') || '',
          room: u.searchParams.get('room') || '',
          max: u.searchParams.get('max') || '',
          strict: u.searchParams.get('only') === '1',
          pid: u.searchParams.get('pid') || '',
          name: u.searchParams.get('name') || ''
        });
        return new Response('upgraded', { status: 200 });
      }
      /* the server list, the same way the real object answers it */
      if (u.pathname === '/servers') {
        return new Response(JSON.stringify({
          ok: true, servers: rooms.core.serverList(u.searchParams.get('game') || '')
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return presence.get('hub').fetch(url, init);
    }
  };
  return {
    core: presence.core,
    rooms: rooms,
    waiting: waiting,
    idFromName(name) { return name === 'rooms' ? 'rooms' : 'hub'; },
    get(id) { return id === 'rooms' ? stub : presence.get('hub'); }
  };
}
