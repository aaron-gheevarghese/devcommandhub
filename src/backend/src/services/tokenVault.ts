// src/backend/src/services/tokenVault.ts
// Encrypts the user's GitHub token while their job waits in the queue, so the worker can act
// on their repo without the token sitting in the database in plain text.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function key(): Buffer {
  const secret = process.env.DCH_TOKEN_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!secret) {throw new Error('Set DCH_TOKEN_KEY to store GitHub tokens');}
  return createHash('sha256').update(`devcommandhub-token-vault:${secret}`).digest();
}

export function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptToken(payload: string): string {
  const [version, iv, tag, enc] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !enc) {throw new Error('Unrecognized token payload');}
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}
