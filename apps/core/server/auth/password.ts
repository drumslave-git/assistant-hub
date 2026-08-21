import "server-only";

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Operator password hashing — scrypt from node:crypto, no new dependency. The
 * stored form is self-describing (`scrypt:N:r:p:<saltB64>:<hashB64>`) so the
 * parameters can be raised later without invalidating existing hashes.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/** Hash a password for storage. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

/** Whether a password matches a stored hash. Constant-time on the digest. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length === 0) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    // Corrupt parameters — treat as no match rather than crash a login.
    return false;
  }
}
