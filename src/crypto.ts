import crypto from 'node:crypto';
import { config } from './config.js';

const ALGO = 'aes-256-gcm';

function keyBytes(): Buffer {
  const raw = config.credentialsKey;
  if (raw && raw.length >= 32) {
    return crypto.createHash('sha256').update(raw).digest();
  }
  // Ephemeral fallback so the app can boot; persisted ciphertext won't decrypt after restart.
  const g = globalThis as unknown as { __ephemeralCredKey?: Buffer };
  if (!g.__ephemeralCredKey) {
    g.__ephemeralCredKey = crypto.randomBytes(32);
  }
  return g.__ephemeralCredKey;
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBytes(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptJson<T = unknown>(payload: string): T {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, keyBytes(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}
