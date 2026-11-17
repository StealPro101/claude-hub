/* The same tiny storage interface as Cloudflare KV, backed by one JSON file.
   Local runs only - the Worker on Cloudflare always uses KV. */
import fs from 'node:fs';
import path from 'node:path';

export function fileStore(file) {
  const full = path.resolve(file);
  let data = {};
  let blobs = {};
  try {
    data = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    data = {};
  }
  try {
    blobs = JSON.parse(fs.readFileSync(full.replace(/\.json$/, '') + '-blobs.json', 'utf8'));
  } catch (e) {
    blobs = {};
  }

  function saveBlobs() {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full.replace(/\.json$/, '') + '-blobs.json', JSON.stringify(blobs));
  }

  function save() {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(data, null, 2));
  }

  return {
    file: full,
    async get(key) {
      const raw = data[key];
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key, value) {
      data[key] = JSON.stringify(value);
      save();
    },
    async delete(key) {
      delete data[key];
      if (blobs[key]) {
        delete blobs[key];
        saveBlobs();
      }
      save();
    },
    async putBytes(key, bytes, type) {
      blobs[key] = { type: type, b64: Buffer.from(bytes).toString('base64') };
      saveBlobs();
    },
    async getBytes(key) {
      const row = blobs[key];
      if (!row) return null;
      return { bytes: new Uint8Array(Buffer.from(row.b64, 'base64')), type: row.type };
    },
    async list(prefix) {
      return Object.keys(data)
        .filter((k) => k.startsWith(prefix) && !k.startsWith('secret:') && !k.startsWith('cover:'))
        .sort()
        .map((k) => ({ key: k, value: JSON.parse(data[k]) }));
    },
    reset() {
      data = {};
      blobs = {};
      saveBlobs();
      save();
    }
  };
}
