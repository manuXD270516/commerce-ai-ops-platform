import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'v1';

export function hashEmail(email: string): Buffer {
  return createHash('sha256').update(email.trim().toLowerCase()).digest();
}

export function encryptEmail(email: string, keyHex: string): Buffer {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(email.trim().toLowerCase(), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(PREFIX), iv, tag, ciphertext]);
}

export function decryptEmail(blob: Buffer, keyHex: string): string {
  const prefix = blob.subarray(0, 2).toString();
  if (prefix !== PREFIX) throw new Error('unsupported ciphertext version');
  const iv = blob.subarray(2, 14);
  const tag = blob.subarray(14, 30);
  const ciphertext = blob.subarray(30);
  const decipher = createDecipheriv('aes-256-gcm', keyFromHex(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function keyFromHex(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('PII_ENCRYPTION_KEY must be 32 bytes as 64 hex chars');
  }
  return Buffer.from(keyHex, 'hex');
}
