import { createHash, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { brands, categories, orderEvents, orderItems, orders, products, users, type Spec } from '../db/schema.js';
import { HttpError, parse } from '../http.js';
import { categoriesOf, inCategories, setProductCategories } from '../lib/categories.js';
import { changeOrderStatus, NEXT_STATUS } from './orders.js';

/**
 * Server-to-server API for the Wall2Roof admin ("ElectroDash view").
 * Contract: Desktop\Wall2Roof\docs\electrodash-integration-api.md
 *
 * - Auth: `Authorization: Bearer <WALL2ROOF_ADMIN_KEY>`, compared in constant time.
 *   No key (or < 32 chars) on the server → 503; wrong key → 401. Never from the query string.
 * - Errors: `{"error": "message"}`. Money in paise. Lists: `{data, meta:{page,per_page,total,last_page}}`.
 */

const MIN_KEY_LENGTH = 32;

function digest(v: string) {
  return createHash('sha256').update(v).digest();
}

/** Constant-time comparison of a presented key with the configured one. */
export function keyMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function authHook(key: string | null | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!key || key.length < MIN_KEY_LENGTH) {
      return reply.status(503).send({ error: 'Integration API is not configured on this server.' });
    }
    const h = req.headers.authorization;
    const presented = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!presented || !keyMatches(presented, key)) {
      return reply.status(401).send({ error: 'Invalid or missing integration key.' });
    }
  };
}

const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
};

function meta(page: number, perPage: number, total: number) {
  return { page, per_page: perPage, total, last_page: Math.max(1, Math.ceil(total / perPage)) };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

/** "Lighting › LED Bulbs" from the parent chain. */
async function categoryPaths(db: Db): Promise<Map<number, { id: number; name: string; path: string }>> {
  const all = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories);
  const byId = new Map(all.map((c) => [c.id, c]));
  const out = new Map<number, { id: number; name: string; path: string }>();
  for (const c of all) {
    const names: string[] = [];
    let cur: (typeof all)[number] | undefined = c;
    for (let guard = 0; cur && guard < 10; guard++) {
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    out.set(c.id, { id: c.id, name: c.name, path: names.join(' › ') });
  }
  return out;
}

/** One product exactly as Wall2Roof's GET /api/v1/products returns it (fields we use; others pass through). */
const wall2roofProduct = z
  .object({
    id: z.coerce.number().int().positive(),
    sku: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(300),
    brand: z.object({ id: z.unknown().optional(), name: z.string().trim().min(1).max(120) }).nullish(),
    active: z.boolean(),
    price: z.coerce.number().nonnegative().nullish(),
    special_price: z.coerce.number().nonnegative().nullish(),
    mrp: z.coerce.number().nonnegative().nullish(),
    short_description: z.string().nullish(),
    description_html: z.string().nullish(),
    images: z.array(z.string().url()).max(30).nullish(),
    attributes: z
      .array(
        z.object({
          code: z.string().nullish(),
          name: z.string().nullish(),
          value: z.union([z.string(), z.number()]).nullish(),
          unit: z.string().nullish(),
        }),
      )
      .nullish(),
  })
  .passthrough();

export type Wall2RoofProduct = z.infer<typeof wall2roofProduct>;

const toPaise = (rupees: number) => Math.round(rupees * 100);

/** Field mapping from the contract (also what a pull-sync would use). */
export function mapWall2RoofProduct(p: Wall2RoofProduct) {
  const hasPrice = p.price != null && p.price > 0;
  const selling = hasPrice ? toPaise(p.special_price != null && p.special_price > 0 ? p.special_price : p.price!) : null;
  const mrp = hasPrice ? Math.max(toPaise(p.mrp != null && p.mrp > 0 ? p.mrp : p.price!), selling!) : null;
  const specs: Spec[] = (p.attributes ?? [])
    .map((a) => ({
      label: (a.name ?? a.code ?? '').trim(),
      value: [a.value == null ? '' : String(a.value).trim(), (a.unit ?? '').trim()].filter(Boolean).join(' '),
    }))
    .filter((s) => s.label && s.value);
  const short = p.short_description?.trim();
  return {
    name: p.name,
    brandName: p.brand?.name ?? null,
    description: p.description_html?.trim() || null,
    // A short one-line description doubles as the spec line under the name; long text is left out.
    subtitle: short && short.length <= 120 && !short.includes('\n') ? short : undefined,
    specs,
    images: p.images ?? [],
    pricePaise: selling,
    mrpPaise: mrp,
    isActive: p.active && hasPrice,
  };
}

async function brandIdFor(db: Db, name: string | null): Promise<number | null> {
  if (!name) return null;
  const slug = slugify(name) || 'brand';
  const [existing] = await db.select({ id: brands.id }).from(brands).where(eq(brands.slug, slug));
  if (existing) return existing.id;
  const [created] = await db
    .insert(brands)
    .values({ slug, name, source: 'laravel' })
    .onConflictDoUpdate({ target: brands.slug, set: { name } })
    .returning({ id: brands.id });
  return created.id;
}

async function uniqueSlug(db: Db, base: string, sku: string): Promise<string> {
  const slug = slugify(base) || slugify(sku) || 'product';
  const [taken] = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
  return taken ? `${slug}-${slugify(sku)}`.slice(0, 120) : slug;
}

function productOut(
  p: typeof products.$inferSelect,
  brandName: string | null,
  paths: Map<number, { id: number; name: string; path: string }>,
  categoryIds: number[],
) {
  return {
    id: p.id,
    sku: p.sku,
    source: p.source,
    source_id: p.sourceId,
    name: p.name,
    slug: p.slug,
    brand: brandName,
    category: p.categoryId ? (paths.get(p.categoryId) ?? null) : null,
    /** every category the product is listed in, main first */
    category_ids: categoryIds,
    price_paise: p.pricePaise,
    mrp_paise: p.mrpPaise,
    stock_qty: p.stockQty,
    is_active: p.isActive,
    images: p.images,
    updated_at: iso(p.updatedAt),
  };
}

export async function integrationRoutes(app: FastifyInstance, { db, key }: { db: Db; key: string | null | undefined }) {
  await app.register(
    async (scope) => {
      // This API answers {"error": "..."}; bad input is 422.
      scope.setErrorHandler((err, req, reply) => {
        if (err instanceof HttpError) {
          const status = err.code === 'invalid_input' ? 422 : err.status;
          return reply.status(status).send({ error: err.message });
        }
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status < 500) return reply.status(status === 400 ? 422 : status).send({ error: 'The request was not valid.' });
        req.log.error(err);
        return reply.status(500).send({ error: 'Something went wrong.' });
      });
      scope.addHook('onRequest', authHook(key));

      // ---- Products ----
      scope.get('/products', async (req) => {
        const q = parse(
          z.object({
            ...pageQuery,
            q: z.string().trim().max(100).optional(),
            active: z.enum(['1', '0']).optional(),
            category_id: z.coerce.number().int().positive().optional(),
            source: z.enum(['laravel', 'admin', 'demo']).optional(),
          }),
          req.query,
        );
        const conds: SQL[] = [];
        if (q.q) {
          const like = `%${q.q.replace(/[%_]/g, '')}%`;
          conds.push(or(ilike(products.name, like), ilike(products.sku, like))!);
        }
        if (q.active) conds.push(eq(products.isActive, q.active === '1'));
        if (q.category_id) conds.push(inCategories(db, [q.category_id]));
        if (q.source) conds.push(eq(products.source, q.source));
        const where = conds.length ? and(...conds) : undefined;
        const [rows, [{ total }], paths] = await Promise.all([
          db
            .select({ p: products, brandName: brands.name })
            .from(products)
            .leftJoin(brands, eq(brands.id, products.brandId))
            .where(where)
            .orderBy(desc(products.updatedAt), desc(products.id))
            .limit(q.per_page)
            .offset((q.page - 1) * q.per_page),
          db.select({ total: sql<number>`count(*)::int` }).from(products).where(where),
          categoryPaths(db),
        ]);
        const cats = await categoriesOf(db, rows.map((r) => r.p));
        return { data: rows.map((r) => productOut(r.p, r.brandName, paths, cats.get(r.p.id) ?? [])), meta: meta(q.page, q.per_page, total) };
      });

      scope.get('/products/skus', async () => {
        const rows = await db.select({ sku: products.sku }).from(products).orderBy(products.sku);
        return { skus: rows.map((r) => r.sku) };
      });

      scope.put('/products/:sku', async (req) => {
        const { sku } = parse(z.object({ sku: z.string().trim().min(1).max(100) }), req.params);
        const body = parse(
          z.object({
            product: wall2roofProduct,
            category_id: z.number().int().positive().nullish(),
            /** every category, main first; replaces the product's set ([] clears it) */
            category_ids: z.array(z.number().int().positive()).max(10).optional(),
            stock_qty: z.number().int().min(0).max(1_000_000).nullish(),
          }),
          req.body,
        );
        if (body.product.sku !== sku) {
          throw new HttpError(422, 'invalid_input', `product.sku (${body.product.sku}) doesn't match the URL (${sku}).`);
        }
        // category_ids sets all of them (first = main); category_id alone keeps its old meaning of
        // "this one category"; with neither, the product keeps its categories.
        const catIds = body.category_ids ? [...new Set(body.category_ids)] : body.category_id != null ? [body.category_id] : null;
        if (catIds?.length) {
          const found = new Set((await db.select({ id: categories.id }).from(categories).where(inArray(categories.id, catIds))).map((c) => c.id));
          const missing = catIds.find((id) => !found.has(id));
          if (missing != null) throw new HttpError(422, 'invalid_input', `Category ${missing} doesn't exist.`);
        }
        const m = mapWall2RoofProduct(body.product);
        const brandId = await brandIdFor(db, m.brandName);
        const [existing] = await db.select().from(products).where(eq(products.sku, sku));

        const common = {
          name: m.name,
          brandId,
          description: m.description,
          ...(m.subtitle !== undefined ? { subtitle: m.subtitle } : {}),
          specs: m.specs,
          images: m.images,
          isActive: m.isActive,
          source: 'laravel' as const,
          sourceId: String(body.product.id),
          ...(body.stock_qty != null ? { stockQty: body.stock_qty } : {}),
          updatedAt: new Date(),
        };

        const slug = existing ? null : await uniqueSlug(db, `${m.brandName ?? ''} ${m.name}`, sku);
        return db.transaction(async (tx) => {
          let id: number;
          if (existing) {
            await tx
              .update(products)
              .set({
                ...common,
                // No price from Wall2Roof → keep the last known price (the product is inactive anyway).
                pricePaise: m.pricePaise ?? existing.pricePaise,
                mrpPaise: m.mrpPaise ?? Math.max(existing.mrpPaise, existing.pricePaise),
              })
              .where(eq(products.id, existing.id));
            id = existing.id;
          } else {
            const [created] = await tx
              .insert(products)
              .values({ ...common, sku, slug: slug!, pricePaise: m.pricePaise ?? 0, mrpPaise: m.mrpPaise ?? 0 })
              .returning({ id: products.id });
            id = created.id;
          }
          if (catIds) await setProductCategories(tx, id, catIds);
          return { ok: true, id, created: !existing };
        });
      });

      // ---- Categories ----
      scope.get('/categories', async () => {
        const rows = await db.select().from(categories).orderBy(categories.sort, categories.name);
        return {
          data: rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, parent_id: c.parentId, is_active: c.isActive, sort: c.sort })),
        };
      });

      // ---- Orders ----
      const STATUSES = ['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled'] as const;
      const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

      scope.get('/orders', async (req) => {
        const q = parse(
          z.object({
            ...pageQuery,
            status: z.enum(STATUSES).optional(),
            q: z.string().trim().max(40).optional(),
            from: dateParam.optional(),
            to: dateParam.optional(),
          }),
          req.query,
        );
        const conds: SQL[] = [];
        if (q.status) conds.push(eq(orders.status, q.status));
        if (q.q) {
          const digits = q.q.replace(/\D/g, '');
          const phone = digits.length >= 10 ? digits.slice(-10) : digits;
          conds.push(
            or(ilike(orders.number, `%${q.q.replace(/[%_]/g, '')}%`), phone.length >= 4 ? ilike(users.phone, `%${phone}%`) : undefined)!,
          );
        }
        // Dates are whole days in India time.
        if (q.from) conds.push(gte(orders.createdAt, new Date(`${q.from}T00:00:00+05:30`)));
        if (q.to) {
          const end = new Date(`${q.to}T00:00:00+05:30`);
          end.setUTCDate(end.getUTCDate() + 1);
          conds.push(lt(orders.createdAt, end));
        }
        const where = conds.length ? and(...conds) : undefined;
        const [rows, [{ total }]] = await Promise.all([
          db
            .select({ o: orders, name: users.name, phone: users.phone })
            .from(orders)
            .innerJoin(users, eq(users.id, orders.userId))
            .where(where)
            .orderBy(desc(orders.createdAt), desc(orders.id))
            .limit(q.per_page)
            .offset((q.page - 1) * q.per_page),
          db
            .select({ total: sql<number>`count(*)::int` })
            .from(orders)
            .innerJoin(users, eq(users.id, orders.userId))
            .where(where),
        ]);
        const counts = rows.length
          ? await db
              .select({ orderId: orderItems.orderId, n: sql<number>`sum(${orderItems.qty})::int` })
              .from(orderItems)
              .where(inArray(orderItems.orderId, rows.map((r) => r.o.id)))
              .groupBy(orderItems.orderId)
          : [];
        const byOrder = new Map(counts.map((c) => [c.orderId, c.n]));
        return {
          data: rows.map(({ o, name, phone }) => ({
            number: o.number,
            status: o.status,
            payment_method: o.paymentMethod,
            payment_status: o.paymentStatus,
            total_paise: o.totalPaise,
            item_count: byOrder.get(o.id) ?? 0,
            customer: { name: name ?? o.address.name, phone: phone ?? o.address.phone },
            created_at: iso(o.createdAt),
          })),
          meta: meta(q.page, q.per_page, total),
        };
      });

      scope.get('/orders/:number', async (req) => {
        const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
        const [row] = await db
          .select({ o: orders, u: users })
          .from(orders)
          .innerJoin(users, eq(users.id, orders.userId))
          .where(eq(orders.number, number));
        if (!row) throw new HttpError(404, 'not_found', 'Order not found.');
        const { o, u } = row;
        const [items, events] = await Promise.all([
          db.select().from(orderItems).where(eq(orderItems.orderId, o.id)).orderBy(orderItems.id),
          db.select().from(orderEvents).where(eq(orderEvents.orderId, o.id)).orderBy(orderEvents.createdAt, orderEvents.id),
        ]);
        return {
          number: o.number,
          status: o.status,
          payment_method: o.paymentMethod,
          payment_status: o.paymentStatus,
          payment_ref: o.paymentRef,
          customer: { id: u.id, name: u.name, phone: u.phone, email: u.email },
          address: o.address,
          delivery_instructions: o.deliveryInstructions,
          items: items.map((i) => ({
            sku: i.sku,
            name: i.name,
            image: i.image,
            qty: i.qty,
            unit_price_paise: i.unitPricePaise,
            unit_mrp_paise: i.unitMrpPaise,
          })),
          subtotal_paise: o.subtotalPaise,
          mrp_total_paise: o.mrpTotalPaise,
          delivery_fee_paise: o.deliveryFeePaise,
          handling_fee_paise: o.handlingFeePaise,
          cod_fee_paise: o.codFeePaise,
          discount_paise: o.discountPaise,
          tip_paise: o.tipPaise,
          total_paise: o.totalPaise,
          coupon_code: o.couponCode,
          cancel_reason: o.cancelReason,
          gstin: o.gstin,
          gst_business_name: o.gstBusinessName,
          /** path on this server, e.g. /voice/12/<id>.m4a */
          voice_note: o.voiceNote ? `/voice/${o.voiceNote}` : null,
          events: events.map((e) => ({ status: e.status, note: e.note, created_at: iso(e.createdAt) })),
          next_statuses: NEXT_STATUS[o.status],
          created_at: iso(o.createdAt),
          updated_at: iso(o.updatedAt),
        };
      });

      scope.post('/orders/:number/status', async (req) => {
        const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
        const body = parse(
          z.object({
            status: z.enum(['confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled']),
            note: z.string().trim().max(200).optional(),
          }),
          req.body,
        );
        await changeOrderStatus(db, number, body.status, body.note || undefined);
        return { ok: true };
      });
    },
    { prefix: '/v1/integration' },
  );
}
