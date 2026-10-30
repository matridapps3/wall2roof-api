import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { otpCodes, refreshTokens, users } from '../db/schema.js';
import { HttpError, parse } from '../http.js';
import {
  hashOtp,
  hashPassword,
  isStrongEnough,
  newOtp,
  newRefreshToken,
  normalizeIndianMobile,
  PASSWORD_RULE,
  safeEqualHex,
  sha256,
  signAccessToken,
  verifyPassword,
} from '../lib/auth.js';
import { config } from '../config.js';
import { checkSentOtp, sendOtp, type OtpDelivery } from '../lib/otp-sender.js';
import { getSettings } from '../lib/settings.js';

const OTP_TTL_MS = 5 * 60_000;
const OTP_RESEND_SEC = 30;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;

export function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    hasPassword: !!u.passwordHash,
    notifyOffers: u.notifyOffers,
    memberSince: u.createdAt.toISOString(),
  };
}

async function createSession(db: Db, u: typeof users.$inferSelect) {
  const { token, hash } = newRefreshToken();
  const [row] = await db
    .insert(refreshTokens)
    .values({ userId: u.id, tokenHash: hash, expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000) })
    .returning({ id: refreshTokens.id });
  return { refreshId: row.id, session: { accessToken: await signAccessToken(u.id, u.role), refreshToken: token, user: publicUser(u) } };
}

async function issueTokens(db: Db, u: typeof users.$inferSelect) {
  return (await createSession(db, u)).session;
}

const phoneBody = z.object({ phone: z.string().min(10).max(16) });

function phoneOr400(raw: string): string {
  const phone = normalizeIndianMobile(raw);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid 10-digit mobile number.');
  return phone;
}

export async function authRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.post('/v1/auth/otp/request', async (req) => {
    const phone = phoneOr400(parse(phoneBody, req.body).phone);
    const recent = await db
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), gt(otpCodes.createdAt, new Date(Date.now() - 3_600_000))))
      .orderBy(desc(otpCodes.createdAt));
    const last = recent[0];
    if (last) {
      const wait = OTP_RESEND_SEC - Math.floor((Date.now() - last.createdAt.getTime()) / 1000);
      if (wait > 0) throw new HttpError(429, 'otp_too_soon', `Please wait ${wait}s before requesting a new code.`);
    }
    if (recent.length >= OTP_MAX_PER_HOUR) {
      throw new HttpError(429, 'otp_limit', 'Too many codes requested. Try again in an hour.');
    }
    // the store reviewers' number: a fixed code they were given, no SMS
    const reviewer = !!config.REVIEW_PHONE && !!config.REVIEW_OTP && phone === config.REVIEW_PHONE;
    const code = reviewer ? config.REVIEW_OTP! : newOtp();
    const delivery: OtpDelivery = reviewer ? { sent: true } : await sendOtp(phone, code, req.log, (await getSettings(db)).testLogin);
    await db.insert(otpCodes).values({
      phone,
      // a provider that made its own code (Message Central): keep its id instead of our code's hash
      codeHash: delivery.verificationId ? '' : hashOtp(phone, code),
      verificationId: delivery.verificationId ?? null,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });
    return {
      sent: true,
      resendInSec: Math.max(OTP_RESEND_SEC, delivery.resendInSec ?? 0),
      ...(delivery.devCode ? { devCode: delivery.devCode } : {}),
    };
  });

  app.post('/v1/auth/otp/verify', async (req) => {
    const body = parse(phoneBody.extend({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
    const phone = phoneOr400(body.phone);
    const [otp] = await db
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);
    if (!otp) throw new HttpError(400, 'otp_expired', 'This code has expired. Request a new one.');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new HttpError(429, 'otp_locked', 'Too many wrong attempts. Request a new code.');
    }
    const check = otp.verificationId
      ? await checkSentOtp(phone, otp.verificationId, body.code)
      : safeEqualHex(otp.codeHash, hashOtp(phone, body.code))
        ? 'ok'
        : 'wrong';
    if (check === 'expired') throw new HttpError(400, 'otp_expired', 'This code has expired. Request a new one.');
    if (check === 'locked') throw new HttpError(429, 'otp_locked', 'Too many wrong attempts. Request a new code.');
    if (check === 'wrong') {
      await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
      throw new HttpError(400, 'otp_wrong', 'That code is incorrect. Check the SMS and try again.');
    }
    await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));

    let [user] = await db.select().from(users).where(eq(users.phone, phone));
    const isNew = !user;
    if (!user) {
      [user] = await db.insert(users).values({ phone, phoneVerifiedAt: new Date() }).returning();
    } else if (!user.phoneVerifiedAt) {
      [user] = await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id)).returning();
    }
    return { ...(await issueTokens(db, user)), isNew };
  });

  app.post('/v1/auth/register', async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1, 'Enter your name').max(80),
        email: z.email('Enter a valid email').transform((e) => e.toLowerCase()),
        password: z.string().max(128).refine(isStrongEnough, PASSWORD_RULE),
      }),
      req.body,
    );
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (exists) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
    const [user] = await db
      .insert(users)
      .values({ name: body.name, email: body.email, passwordHash: await hashPassword(body.password) })
      .returning();
    return { ...(await issueTokens(db, user)), isNew: true };
  });

  app.post('/v1/auth/login', async (req) => {
    const body = parse(
      z.object({ email: z.email().transform((e) => e.toLowerCase()), password: z.string().min(1).max(128) }),
      req.body,
    );
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    // Same message either way, so the form doesn't reveal which emails have accounts.
    if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new HttpError(401, 'bad_credentials', 'Email or password is incorrect.');
    }
    return { ...(await issueTokens(db, user)), isNew: false };
  });

  app.post('/v1/auth/refresh', async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, sha256(refreshToken)),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      );
    if (!row) throw new HttpError(401, 'session_expired', 'Your session has expired. Please log in again.');
    const [user] = await db.select().from(users).where(eq(users.id, row.userId));
    if (!user) throw new HttpError(401, 'session_expired', 'Your session has expired. Please log in again.');

    // Customers stay logged in until they log out. A token stays usable until the phone has used
    // the one it was swapped for, so a refresh whose reply got lost (weak signal, app closed at
    // that moment) just gets a fresh token instead of logging the customer out.
    const now = new Date();
    // Using this token proves the phone has it, so the token it replaced is finished.
    await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.replacedById, row.id), isNull(refreshTokens.revokedAt)));
    // Swapped before but the phone never used the new one: retire that unused one.
    if (row.replacedById) {
      await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.id, row.replacedById), isNull(refreshTokens.revokedAt)));
    }
    const { refreshId, session } = await createSession(db, user);
    await db.update(refreshTokens).set({ replacedById: refreshId }).where(eq(refreshTokens.id, row.id));
    return session;
  });

  app.post('/v1/auth/logout', async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
    return { ok: true };
  });
}
