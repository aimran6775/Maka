// The snapshot format (phase 3 step 5), core modules only: a ustar tar of the files,
// gzip, then AES-256-GCM with a 32-byte key. Pure functions over Buffers.
//
//   packTar(entries) / readTar(buf)      entries: { path, data, mode?, mtime? }
//   encrypt(plain, key) / decrypt(sealed, key)
//     sealed = "MAKA1" | iv (12) | tag (16) | ciphertext; the tag covers the header too.
//   seal(entries, key) / open(sealed, key)   tar → gzip → encrypt, and back

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const MAGIC = Buffer.from('MAKA1', 'latin1');
export const KEY_BYTES = 32;
const BLOCK = 512;

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(entry) {
  const buf = Buffer.alloc(BLOCK, 0);
  const name = entry.path;
  if (Buffer.byteLength(name) > 100) {
    // ustar prefix/name split at a slash so long paths survive.
    const idx = name.lastIndexOf('/', 155);
    if (idx <= 0 || Buffer.byteLength(name.slice(idx + 1)) > 100 || Buffer.byteLength(name.slice(0, idx)) > 155) throw new Error(`path too long for tar: ${name}`);
    buf.write(name.slice(idx + 1), 0, 100);
    buf.write(name.slice(0, idx), 345, 155);
  } else {
    buf.write(name, 0, 100);
  }
  buf.write(octal(entry.mode ?? 0o644, 8), 100);
  buf.write(octal(0, 8), 108);
  buf.write(octal(0, 8), 116);
  buf.write(octal(entry.data.length, 12), 124);
  buf.write(octal(Math.floor((entry.mtime ?? 0) / 1000), 12), 136);
  buf.write('        ', 148); // checksum placeholder
  buf.write('0', 156); // regular file
  buf.write('ustar\0', 257);
  buf.write('00', 263);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return buf;
}

export function packTar(entries) {
  const parts = [];
  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || !e.path || e.path.startsWith('/') || e.path.split('/').includes('..')) throw new Error(`bad tar entry path: ${e && e.path}`);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    parts.push(header({ ...e, data }), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

const readStr = (buf, off, len) => buf.subarray(off, off + len).toString('utf8').replace(/\0.*$/s, '');

export function readTar(buf) {
  const out = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = readStr(h, 0, 100);
    const prefix = readStr(h, 345, 155);
    const size = parseInt(readStr(h, 124, 12).trim() || '0', 8);
    const mode = parseInt(readStr(h, 100, 8).trim() || '644', 8);
    const mtime = parseInt(readStr(h, 136, 12).trim() || '0', 8) * 1000;
    const type = h[156];
    const path = prefix ? `${prefix}/${name}` : name;
    const data = buf.subarray(off + BLOCK, off + BLOCK + size);
    if (type === 0 || type === 0x30) out.push({ path, data: Buffer.from(data), mode, mtime });
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

export function encrypt(plain, key, { iv = randomBytes(12) } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error(`the backup key must be ${KEY_BYTES} bytes`);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

export function decrypt(sealed, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error(`the backup key must be ${KEY_BYTES} bytes`);
  if (sealed.length < MAGIC.length + 28 || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw Object.assign(new Error('not a Maka snapshot (bad header)'), { code: 'BAD_SNAPSHOT' });
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = sealed.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const ct = sealed.subarray(MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw Object.assign(new Error('the snapshot does not open with this key (wrong key or damaged file)'), { code: 'BAD_KEY' });
  }
}

export function seal(entries, key) {
  return encrypt(gzipSync(packTar(entries), { level: 6 }), key);
}

export function open(sealed, key) {
  return readTar(gunzipSync(decrypt(sealed, key)));
}

export function keyFromHex(hex) {
  const clean = String(hex || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(clean)) throw Object.assign(new Error('the backup key must be 64 hex characters (32 bytes)'), { code: 'BAD_KEY' });
  return Buffer.from(clean, 'hex');
}

export function newKeyHex() {
  return randomBytes(KEY_BYTES).toString('hex');
}
