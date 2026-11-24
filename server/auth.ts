/**
 * Session authentication.
 *
 * The vault is account-scoped, so identity must be trustworthy and must never be
 * something the client can assert (the local test harness used a header for
 * convenience; production must not). Sessions are:
 *
 *  - 256-bit tokens from `crypto.randomBytes`, stored server-side so they can be
 *    revoked, with only their SHA-256 hash persisted;
 *  - delivered in an `HttpOnly`, `SameSite=Lax`, `Secure`-when-HTTPS cookie;
 *  - expired after 30 days of inactivity;
 *  - paired with password hashing via `scrypt` (memory-hard, no native deps).
 *
 * Account ids are derived from the user id, so each account's tables and stored
 * parts are physically separated.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const SESSION_COOKIE = 'datanest_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KEY_LENGTH = 64;

export type SessionUser = { userId: string; email: string; name: string };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Stable, filesystem-safe account key. This is what names the per-account tables
 * and storage prefixes, so it must be derived only from the server's user id.
 */
export function accountKey(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

/** Minimal RFC-6265 parser; only the cookies DataNest sets are considered. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookie(
  token: string,
  options: { secure: boolean; maxAgeSeconds?: number }
): string {
  const attributes = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + (options.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000)),
  ];
  // `Secure` is only set over HTTPS: setting it on a plain-HTTP host would make
  // the browser drop the cookie and lock users out of their own vault.
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}
