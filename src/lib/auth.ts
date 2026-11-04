import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';

import { config } from '../config.js';

export type AccessClaims = { sub: string; role: 'customer' | 'admin' };

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signAccessToken(userId: number, role: AccessClaims['role']): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_MIN}m`)
    .setIssuer('electrodash')
    .sign(config.jwtSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: 'electrodash' });
    if (typeof payload.sub !== 'string') return null;
    // anything else, such as a login from when the `staff` role existed, is a customer
    const role = payload.role === 'admin' ? 'admin' : 'customer';
    return { sub: payload.sub, role };
  } catch {
    return null;
  }
}

/** Opaque refresh token; only its SHA-256 is stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** OTPs are hashed with the server secret so a database leak doesn't reveal live codes. */
export function hashOtp(phone: string, code: string): string {
  return createHash('sha256').update(`${phone}:${code}:`).update(config.jwtSecret).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** "+91 98765-43210" → "9876543210"; null if not a valid Indian mobile. */
export function normalizeIndianMobile(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export const PASSWORD_RULE = 'Use at least 8 characters, with letters and numbers';

export function isStrongEnough(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}
