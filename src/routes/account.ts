import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import {
  addresses,
  brands,
  cartItems,
  notifications,
  orders,
  otpCodes,
  productReviews,
  products,
  refreshTokens,
  returnRequests,
  supportMessages,
  users,
  wishlist,
} from '../db/schema.js';
import { HttpError, idParam, parse, requireUser } from '../http.js';
import { hashPassword, isStrongEnough, normalizeIndianMobile, PASSWORD_RULE } from '../lib/auth.js';
import { refreshProductRatings } from '../lib/reviews.js';
import type { VoiceStore } from '../lib/voice.js';
import { publicUser } from './auth.js';
import { productCard } from './catalog.js';

const addressBody = z.object({
  label: z.enum(['home', 'work', 'other']).default('home'),
  otherLabel: z.string().trim().max(30).nullish(),
  name: z.string().trim().min(1, 'Enter a name').max(80),
  phone: z.string().transform((v, ctx) => {
    const n = normalizeIndianMobile(v);
    if (!n) ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit mobile number' });
    return n ?? '';
  }),
  line1: z.string().trim().min(3, 'Enter house / flat and building').max(200),
  line2: z.string().trim().max(200).nullish(),
  landmark: z.string().trim().max(100).nullish(),
  city: z.string().trim().min(2, 'Enter city').max(80),
  state: z.string().trim().min(2, 'Enter state').max(80),
  pincode: z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code'),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  isDefault: z.boolean().default(false),
});

function addressOut(a: typeof addresses.$inferSelect) {
  return { ...a, lat: a.lat ? Number(a.lat) : null, lng: a.lng ? Number(a.lng) : null };
}

/** Orders still being delivered and returns still being handled: the account can't be deleted until they're done. */
const OPEN_ORDER = ['placed', 'confirmed', 'packed', 'out_for_delivery'] as const;
const OPEN_RETURN = ['requested', 'approved'] as const;

export async function accountRoutes(app: FastifyInstance, { db, voice }: { db: Db; voice: VoiceStore }) {
  app.get('/v1/me', async (req) => {
    const userId = requireUser(req);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || u.deletedAt) throw new HttpError(401, 'session_expired', 'Please log in again.');
    const [o, w, a, n] = await Promise.all([
      db.$count(orders, eq(orders.userId, userId)),
      db.$count(wishlist, eq(wishlist.userId, userId)),
      db.$count(addresses, eq(addresses.userId, userId)),
      db.$count(notifications, and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    ]);
    return { user: publicUser(u), counts: { orders: o, wishlist: w, addresses: a, unreadNotifications: n } };
  });

  app.patch('/v1/me', async (req) => {
    const userId = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        email: z
          .email('Enter a valid email')
          .transform((e) => e.toLowerCase())
          .optional(),
        password: z.string().max(128).refine(isStrongEnough, PASSWORD_RULE).optional(),
        notifyOffers: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.email) {
      const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, body.email), ne(users.id, userId)));
      if (taken) throw new HttpError(409, 'email_taken', 'That email is used by another account.');
    }
    const [u] = await db
      .update(users)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
        ...(body.notifyOffers !== undefined ? { notifyOffers: body.notifyOffers } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return { user: publicUser(u) };
  });

  // Apple and Google require that customers can delete their account in the app. Everything personal
  // goes; orders stay as sales records (GST law), without the name, phone and street address.
  app.delete('/v1/me', async (req) => {
    const userId = requireUser(req);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || u.deletedAt) throw new HttpError(401, 'session_expired', 'Please log in again.');
    if (await db.$count(orders, and(eq(orders.userId, userId), inArray(orders.status, [...OPEN_ORDER])))) {
      throw new HttpError(409, 'open_orders', 'You have an order on its way. You can delete your account once it’s delivered or cancelled.');
    }
    if (await db.$count(returnRequests, and(eq(returnRequests.userId, userId), inArray(returnRequests.status, [...OPEN_RETURN])))) {
      throw new HttpError(409, 'open_returns', 'You have a return in progress. You can delete your account once it’s completed.');
    }
    const rated = await db.transaction(async (tx) => {
      const reviews = await tx.delete(productReviews).where(eq(productReviews.userId, userId)).returning({ productId: productReviews.productId });
      await tx.delete(addresses).where(eq(addresses.userId, userId));
      await tx.delete(cartItems).where(eq(cartItems.userId, userId));
      await tx.delete(wishlist).where(eq(wishlist.userId, userId));
      await tx.delete(notifications).where(eq(notifications.userId, userId));
      // logs them out on every phone
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      if (u.phone) await tx.delete(otpCodes).where(eq(otpCodes.phone, u.phone));
      await tx
        .update(orders)
        .set({
          address: sql`${orders.address} || jsonb_build_object('name', 'Deleted customer', 'phone', '', 'line1', '', 'line2', null, 'landmark', null, 'otherLabel', null, 'lat', null, 'lng', null)`,
          voiceNote: null,
        })
        .where(eq(orders.userId, userId));
      await tx.update(supportMessages).set({ name: 'Deleted customer', email: '', phone: null }).where(eq(supportMessages.userId, userId));
      const now = new Date();
      await tx
        .update(users)
        .set({ name: 'Deleted customer', phone: null, email: null, passwordHash: null, phoneVerifiedAt: null, notifyOffers: false, deletedAt: now, updatedAt: now })
        .where(eq(users.id, userId));
      return [...new Set(reviews.map((r) => r.productId))];
    });
    await refreshProductRatings(db, rated);
    await voice.removeUser(userId).catch((e: unknown) => req.log.error(e, 'could not remove voice notes of a deleted account'));
    return { ok: true };
  });

  // ---- Addresses ----
  app.get('/v1/addresses', async (req) => {
    const userId = requireUser(req);
    const rows = await db
      .select()
      .from(addresses)
      .where(eq(addresses.userId, userId))
      .orderBy(desc(addresses.isDefault), desc(addresses.updatedAt));
    return { addresses: rows.map(addressOut) };
  });

  async function saveAddress(userId: number, body: z.infer<typeof addressBody>, id?: number) {
    return db.transaction(async (tx) => {
      const count = await tx.$count(addresses, eq(addresses.userId, userId));
      const makeDefault = body.isDefault || count === 0 || (count === 1 && id != null);
      if (makeDefault) await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
      const values = {
        ...body,
        lat: body.lat != null ? String(body.lat) : null,
        lng: body.lng != null ? String(body.lng) : null,
        isDefault: makeDefault,
        updatedAt: new Date(),
      };
      if (id == null) {
        const [a] = await tx.insert(addresses).values({ ...values, userId }).returning();
        return a;
      }
      const [a] = await tx
        .update(addresses)
        .set(values)
        .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
        .returning();
      if (!a) throw new HttpError(404, 'not_found', 'Address not found.');
      return a;
    });
  }

  app.post('/v1/addresses', async (req, reply) => {
    const userId = requireUser(req);
    const a = await saveAddress(userId, parse(addressBody, req.body));
    reply.status(201);
    return { address: addressOut(a) };
  });

  app.put('/v1/addresses/:id', async (req) => {
    const userId = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { address: addressOut(await saveAddress(userId, parse(addressBody, req.body), id)) };
  });

  app.post('/v1/addresses/:id/default', async (req) => {
    const userId = requireUser(req);
    const { id } = parse(idParam, req.params);
    await db.transaction(async (tx) => {
      const [a] = await tx.select().from(addresses).where(and(eq(addresses.id, id), eq(addresses.userId, userId)));
      if (!a) throw new HttpError(404, 'not_found', 'Address not found.');
      await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
      await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, id));
    });
    return { ok: true };
  });

  app.delete('/v1/addresses/:id', async (req) => {
    const userId = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [gone] = await db
      .delete(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
      .returning();
    if (!gone) throw new HttpError(404, 'not_found', 'Address not found.');
    if (gone.isDefault) {
      const [next] = await db.select().from(addresses).where(eq(addresses.userId, userId)).limit(1);
      if (next) await db.update(addresses).set({ isDefault: true }).where(eq(addresses.id, next.id));
    }
    return { ok: true };
  });

  // ---- Wishlist ----
  app.get('/v1/wishlist', async (req) => {
    const userId = requireUser(req);
    const rows = await db
      .select({ w: wishlist, p: products, brandName: brands.name })
      .from(wishlist)
      .innerJoin(products, eq(products.id, wishlist.productId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(eq(wishlist.userId, userId))
      .orderBy(desc(wishlist.createdAt));
    return {
      items: rows.map((r) => ({
        ...productCard(r.p, r.brandName ? { name: r.brandName } : null),
        priceDropPaise: Math.max(0, r.w.savedPricePaise - r.p.pricePaise),
      })),
    };
  });

  app.put('/v1/wishlist/:id', async (req) => {
    const userId = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [p] = await db.select().from(products).where(eq(products.id, id));
    if (!p) throw new HttpError(404, 'not_found', 'Product not found.');
    await db.insert(wishlist).values({ userId, productId: id, savedPricePaise: p.pricePaise }).onConflictDoNothing();
    return { ok: true };
  });

  app.delete('/v1/wishlist/:id', async (req) => {
    const userId = requireUser(req);
    const { id } = parse(idParam, req.params);
    await db.delete(wishlist).where(and(eq(wishlist.userId, userId), eq(wishlist.productId, id)));
    return { ok: true };
  });

  // ---- Notifications ----
  app.get('/v1/notifications', async (req) => {
    const userId = requireUser(req);
    const { kind } = parse(z.object({ kind: z.enum(['order', 'offer', 'account']).optional() }), req.query);
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), kind ? eq(notifications.kind, kind) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        orderId: n.orderId,
        read: !!n.readAt,
        at: n.createdAt.toISOString(),
      })),
    };
  });

  app.post('/v1/notifications/read-all', async (req) => {
    const userId = requireUser(req);
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return { ok: true };
  });

  // ---- Support ----
  app.post('/v1/support', async (req, reply) => {
    const userId = req.auth ? Number(req.auth.sub) : null;
    const body = parse(
      z.object({
        name: z.string().trim().max(80).optional(),
        email: z.email('Enter a valid email').optional(),
        phone: z.string().max(16).optional(),
        topic: z.enum(['order', 'payment', 'delivery', 'return', 'product', 'other']),
        message: z.string().trim().min(5, 'Tell us a little more').max(500),
      }),
      req.body,
    );
    if (!body.email && !body.phone && !userId) {
      throw new HttpError(400, 'contact_required', 'Add an email or phone number so we can reply.');
    }
    await db.insert(supportMessages).values({ ...body, name: body.name ?? '', email: body.email ?? '', userId });
    reply.status(201);
    return { ok: true };
  });
}
