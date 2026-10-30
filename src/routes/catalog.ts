import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { banners, brands, categories, homeSections, orderItems, products, type Spec } from '../db/schema.js';
import { HttpError, parse } from '../http.js';
import { categoryKind, categoryMembers, inCategories, subtreeCount } from '../lib/categories.js';
import { facetAndFilter, isFiltering, parsePicked } from '../lib/filters.js';
import { htmlToText } from '../lib/html.js';
import { reviewSummary } from '../lib/reviews.js';
import { getSettings, isServiceable } from '../lib/settings.js';

const TAG_SKIP = /country|origin|warranty|dimension|size|brand|model|sku|hsn|weight|capacity|time|angle|lumen/i;
const TAG_PREFER = [/watt/i, /light colou?r|colou?r temp/i, /colou?r/i, /shape/i, /material/i, /bulb|base|head|type/i];

/**
 * Up to two short spec values for a card's tag chips (Blinkit's "Dry skin" / "IPX5"), e.g.
 * "10W" and "Warm White": short values only, the most useful labels first.
 */
export function cardTags(specs: Spec[]): string[] {
  const rank = (s: Spec) => {
    const i = TAG_PREFER.findIndex((re) => re.test(s.label));
    return i === -1 ? TAG_PREFER.length : i;
  };
  const values = specs
    .filter((s) => s.value && s.value.length <= 14 && !/[()]/.test(s.value) && !TAG_SKIP.test(s.label))
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => s.value.trim());
  return [...new Set(values)].slice(0, 2);
}

/** "Top Rated" needs at least this many ratings, at this average or better (stored ×10). */
const TOP_RATED = { minCount: 3, minAvgX10: 43 };

/** The card's corner tag, like Blinkit's: "Top Rated" from customers' stars, else the admin's "Bestseller". */
export function cardBadge(p: Pick<typeof products.$inferSelect, 'ratingAvg' | 'ratingCount' | 'isBestseller'>): 'Top Rated' | 'Bestseller' | null {
  if (p.ratingCount >= TOP_RATED.minCount && (p.ratingAvg ?? 0) >= TOP_RATED.minAvgX10) return 'Top Rated';
  return p.isBestseller ? 'Bestseller' : null;
}

/** Public product shape (cards, lists). */
export function productCard(p: typeof products.$inferSelect, brand?: { name: string } | null) {
  const discountPct = p.mrpPaise > p.pricePaise ? Math.round(((p.mrpPaise - p.pricePaise) / p.mrpPaise) * 100) : 0;
  return {
    id: p.id,
    sku: p.sku,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    brand: brand?.name ?? null,
    image: p.images[0] ?? null,
    /** First few photos, for swiping through them on the card. */
    images: p.images.slice(0, 5),
    tags: cardTags(p.specs),
    pricePaise: p.pricePaise,
    mrpPaise: p.mrpPaise,
    discountPct,
    rating: p.ratingAvg != null ? p.ratingAvg / 10 : null,
    ratingCount: p.ratingCount,
    badge: cardBadge(p),
    inStock: p.isActive && p.stockQty > 0,
    stockLeft: p.stockQty > 0 && p.stockQty <= 3 ? p.stockQty : null,
    maxPerOrder: Math.max(0, Math.min(p.maxPerOrder, p.stockQty)),
    variantLabel: p.variantLabel,
  };
}

/**
 * Home banners for the app. A banner whose category or product is gone or hidden still shows,
 * but tapping it does nothing, so a stale link never opens a "not available" page.
 */
async function bannerCards(db: Db, rows: (typeof banners.$inferSelect)[]) {
  const slugsOf = (type: 'category' | 'product') =>
    [...new Set(rows.filter((b) => b.linkType === type && b.linkTarget).map((b) => b.linkTarget!))];
  const catSlugs = slugsOf('category');
  const productSlugs = slugsOf('product');
  const [liveCats, liveProducts] = await Promise.all([
    catSlugs.length
      ? db.select({ slug: categories.slug }).from(categories).where(and(inArray(categories.slug, catSlugs), eq(categories.isActive, true)))
      : [],
    productSlugs.length
      ? db.select({ slug: products.slug }).from(products).where(and(inArray(products.slug, productSlugs), eq(products.isActive, true)))
      : [],
  ]);
  const live = { category: new Set(liveCats.map((c) => c.slug)), product: new Set(liveProducts.map((p) => p.slug)) };

  return rows.map((b) => {
    const ok =
      b.linkType === 'offers' || ((b.linkType === 'category' || b.linkType === 'product') && live[b.linkType].has(b.linkTarget ?? ''));
    return {
      id: b.id,
      title: b.title,
      imageUrl: b.imageUrl,
      link: ok ? { type: b.linkType, target: b.linkType === 'offers' ? null : b.linkTarget } : null,
    };
  });
}

/**
 * Live home sections with their categories in the admin's order. A category is left out while
 * it's hidden or has no product shown in the app (counting its subcategories), and a section
 * with no category left is skipped.
 */
async function homeSectionCards(db: Db) {
  const rows = await db
    .select()
    .from(homeSections)
    .where(eq(homeSections.isActive, true))
    .orderBy(asc(homeSections.sort), asc(homeSections.id));
  if (!rows.length) return [];

  const [cats, members] = await Promise.all([
    db
      .select({ id: categories.id, parentId: categories.parentId, slug: categories.slug, name: categories.name, imageUrl: categories.imageUrl, tint: categories.tint, isActive: categories.isActive })
      .from(categories),
    categoryMembers(db),
  ]);
  const kids = new Map<number, number[]>();
  for (const c of cats) if (c.parentId != null) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c.id]);
  const total = (id: number) => subtreeCount(id, members, kids);
  const byId = new Map(cats.map((c) => [c.id, c]));

  return rows
    .map((s) => ({
      id: s.id,
      title: s.title,
      subtitle: s.subtitle,
      categories: s.categoryIds
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => !!c && c.isActive && total(c.id) > 0)
        .map((c) => ({ slug: c.slug, name: c.name, imageUrl: c.imageUrl, tint: c.tint })),
    }))
    .filter((s) => s.categories.length > 0);
}

const listQuery = z.object({
  category: z.string().optional(),
  brand: z.union([z.string(), z.array(z.string())]).optional(),
  /** price bucket keys (see PRICE_BUCKETS) */
  price: z.union([z.string(), z.array(z.string())]).optional(),
  /** "group:value", repeated, e.g. spec=origin:India&spec=light:Warm White */
  spec: z.union([z.string().max(120), z.array(z.string().max(120)).max(30)]).optional(),
  q: z.string().trim().max(100).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  inStock: z.enum(['1', 'true']).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'discount', 'rating', 'newest']).default('relevance'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** All category ids under (and including) the given slug. */
async function categoryIdsFor(db: Db, slug: string): Promise<number[]> {
  const all = await db.select({ id: categories.id, parentId: categories.parentId, slug: categories.slug }).from(categories);
  const root = all.find((c) => c.slug === slug);
  if (!root) return [];
  const ids = [root.id];
  for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId === ids[i]) ids.push(c.id);
  return ids;
}

/**
 * The searched words, each cut to a simple stem so plurals still match: "lights" → "light",
 * "switches" → "switch", "bulbs" → "bulb" ("glass" stays "glass").
 */
export function searchStems(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[%_]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((w) => (w.endsWith('ss') ? w : w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

function searchCondition(q: string): SQL {
  // Every word must match the name, subtitle, SKU, brand — or one of the product's categories, so
  // searching a category ("hanging lights") finds its products, like Blinkit.
  return and(
    ...searchStems(q).map((w) => {
      const like = `%${w}%`;
      return or(
        ilike(products.name, like),
        ilike(products.subtitle, like),
        ilike(products.sku, like),
        ilike(brands.name, like),
        sql`exists (select 1 from categories c where c.name ilike ${like} and (c.id = ${products.categoryId} or c.id in (select pc.category_id from product_categories pc where pc.product_id = ${products.id})))`,
      )!;
    }),
  )!;
}

type CardRow = { p: typeof products.$inferSelect; brandName: string | null };
const card = (r: CardRow) => productCard(r.p, r.brandName ? { name: r.brandName } : null);

/** A shuffled copy (Fisher–Yates), for sections that show a different pick on every visit. */
function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Popular first: in stock, bestsellers, best rated, most rated. */
function byPopularity(a: CardRow, b: CardRow) {
  const inStock = (r: CardRow) => (r.p.stockQty > 0 ? 1 : 0);
  return (
    inStock(b) - inStock(a) ||
    Number(b.p.isBestseller) - Number(a.p.isBestseller) ||
    (b.p.ratingAvg ?? 0) - (a.p.ratingAvg ?? 0) ||
    b.p.ratingCount - a.p.ratingCount ||
    a.p.id - b.p.id
  );
}

/**
 * Blinkit's "People also bought": products bought in the same orders as this one, most often first,
 * topped up with a random pick (bestsellers first, different on every visit) from related categories —
 * other electrical shelves for a wire (switches, sockets…), other lighting for a light — then from any
 * other category. Never from the product's own category: "Similar products" covers that.
 */
async function alsoBought(db: Db, p: typeof products.$inferSelect, limit: number): Promise<CardRow[]> {
  const together = await db
    .select({ id: orderItems.productId, n: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(
      and(
        inArray(orderItems.orderId, db.select({ id: orderItems.orderId }).from(orderItems).where(eq(orderItems.productId, p.id))),
        isNotNull(orderItems.productId),
        ne(orderItems.productId, p.id),
      ),
    )
    .groupBy(orderItems.productId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit * 2);
  const ids = together.flatMap((t) => (t.id == null ? [] : [t.id]));
  const rank = new Map(ids.map((id, i) => [id, i]));
  const bought = ids.length
    ? (
        await db
          .select({ p: products, brandName: brands.name })
          .from(products)
          .leftJoin(brands, eq(brands.id, products.brandId))
          .where(and(inArray(products.id, ids), eq(products.isActive, true)))
      )
        .sort((a, b) => rank.get(a.p.id)! - rank.get(b.p.id)!)
        .slice(0, limit)
    : [];
  if (bought.length >= limit) return bought;

  // categories of the same kind as this product's
  const cats = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories).where(eq(categories.isActive, true));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const kindOf = (id: number | null) => {
    const c = id != null ? byId.get(id) : undefined;
    return c ? categoryKind(c.name, c.parentId != null ? byId.get(c.parentId)?.name : null) : null;
  };
  const kind = kindOf(p.categoryId);
  const related = kind ? cats.filter((c) => c.id !== p.categoryId && kindOf(c.id) === kind).map((c) => c.id) : [];

  const out = [...bought];
  const pick = async (where: SQL | undefined) => {
    if (out.length >= limit) return;
    const rows = await db
      .select({ p: products, brandName: brands.name })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(
        and(
          eq(products.isActive, true),
          notInArray(products.id, [p.id, ...out.map((b) => b.p.id)]),
          p.categoryId ? or(sql`${products.categoryId} is null`, ne(products.categoryId, p.categoryId)) : undefined,
          where,
        ),
      )
      .orderBy(desc(sql`${products.stockQty} > 0`), desc(products.isBestseller), sql`random()`)
      .limit(limit - out.length);
    out.push(...rows);
  };
  if (related.length) await pick(inArray(products.categoryId, related));
  await pick(undefined);
  return out;
}

export async function catalogRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/config', async () => {
    const s = await getSettings(db);
    return {
      deliveryEtaText: s.deliveryEtaText,
      storeAreaText: s.storeAreaText,
      deliveryFeePaise: s.deliveryFeePaise,
      freeDeliveryMinPaise: s.freeDeliveryMinPaise,
      handlingFeePaise: s.handlingFeePaise,
      codFeePaise: s.codFeePaise,
      codEnabled: s.codEnabled,
      onlinePaymentsEnabled: s.onlinePaymentsEnabled,
      support: { phone: s.supportPhone, email: s.supportEmail, hours: s.supportHoursText },
      /** newest APK: older apps offer to download it */
      latestApp: s.latestAppVersion && s.latestAppUrl.startsWith('https://') ? { version: s.latestAppVersion, url: s.latestAppUrl } : null,
    };
  });

  app.get('/v1/serviceability', async (req) => {
    const { pincode } = parse(z.object({ pincode: z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code') }), req.query);
    const s = await getSettings(db);
    const ok = isServiceable(s, pincode);
    return { pincode, serviceable: ok, deliveryEtaText: ok ? s.deliveryEtaText : '' };
  });

  app.get('/v1/categories', async () => {
    const [rows, members] = await Promise.all([
      db
        .select({
          id: categories.id,
          slug: categories.slug,
          name: categories.name,
          parentId: categories.parentId,
          imageUrl: categories.imageUrl,
          tint: categories.tint,
          sort: categories.sort,
        })
        .from(categories)
        .where(eq(categories.isActive, true))
        .orderBy(asc(categories.sort), asc(categories.name)),
      categoryMembers(db),
    ]);
    // A product listed in several categories counts in each, but once per parent.
    type Node = (typeof rows)[number] & { productCount: number; children: Node[]; totalCount: number };
    const nodes = new Map<number, Node>(rows.map((r) => [r.id, { ...r, productCount: members.get(r.id)?.size ?? 0, children: [], totalCount: 0 }]));
    const roots: Node[] = [];
    for (const n of nodes.values()) {
      const parent = n.parentId ? nodes.get(n.parentId) : undefined;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
    const kids = new Map<number, number[]>([...nodes.values()].map((n) => [n.id, n.children.map((c) => c.id)]));
    for (const n of nodes.values()) n.totalCount = subtreeCount(n.id, members, kids);
    // Only categories with at least one active product (in them or a sub-category)
    // are shown, so customers never open an empty category.
    const withProducts = (list: Node[]): Node[] =>
      list.filter((n) => n.totalCount > 0).map((n) => ({ ...n, children: withProducts(n.children) }));
    return { categories: withProducts(roots) };
  });

  app.get('/v1/products', async (req) => {
    const q = parse(listQuery, req.query);
    const conds: SQL[] = [eq(products.isActive, true)];
    if (q.category) {
      const ids = await categoryIdsFor(db, q.category);
      if (!ids.length) return { items: [], total: 0, page: q.page, pages: 0, facets: { brands: [], prices: [], specs: [], categories: [] } };
      conds.push(inCategories(db, ids));
    }
    if (q.q) conds.push(searchCondition(q.q));
    if (q.minPrice != null) conds.push(gte(products.pricePaise, q.minPrice));
    if (q.maxPrice != null) conds.push(lte(products.pricePaise, q.maxPrice));
    if (q.inStock) conds.push(sql`${products.stockQty} > 0`);

    // Brand, price range and product-detail filters (and their counts) are worked out over
    // everything the category/search allows; the page itself is then fetched by id.
    const picked = parsePicked(q);
    const pool = await db
      .select({ id: products.id, pricePaise: products.pricePaise, specs: products.specs, brandSlug: brands.slug, brandName: brands.name, brandLogo: brands.logoUrl, categoryId: products.categoryId })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(and(...conds));
    const { ids, facets: found } = facetAndFilter(pool, picked);
    // Searches: the categories the matching products are in, most first (Blinkit's tiles above results).
    let searchCats: { slug: string; name: string; imageUrl: string | null; count: number }[] = [];
    if (q.q && !q.category) {
      const counts = new Map<number, number>();
      for (const r of pool) if (r.categoryId != null) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
      if (counts.size > 1) {
        const rows = await db
          .select({ id: categories.id, slug: categories.slug, name: categories.name, imageUrl: categories.imageUrl })
          .from(categories)
          .where(and(inArray(categories.id, [...counts.keys()]), eq(categories.isActive, true)));
        searchCats = rows
          .map((c) => ({ slug: c.slug, name: c.name, imageUrl: c.imageUrl, count: counts.get(c.id) ?? 0 }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, 10);
      }
    }
    const facets = { ...found, categories: searchCats };
    const filtering = isFiltering(picked);
    const count = filtering ? ids.length : pool.length;
    if (filtering) {
      if (!ids.length) return { items: [], total: 0, page: q.page, pages: 0, facets };
      conds.push(inArray(products.id, ids));
    }

    const where = and(...conds);
    const order =
      q.sort === 'price_asc'
        ? [asc(products.pricePaise)]
        : q.sort === 'price_desc'
          ? [desc(products.pricePaise)]
          : q.sort === 'discount'
            ? [desc(sql`(${products.mrpPaise} - ${products.pricePaise}) * 100 / greatest(${products.mrpPaise}, 1)`)]
            : q.sort === 'rating'
              ? [desc(sql`coalesce(${products.ratingAvg}, 0)`), desc(products.ratingCount)]
              : q.sort === 'newest'
                ? [desc(products.createdAt)]
                : [desc(sql`${products.stockQty} > 0`), desc(products.isBestseller), desc(products.ratingCount)];
    // Searching: products whose own name has every word come first, then ones found by category/brand.
    if (q.q && q.sort === 'relevance') {
      const stems = searchStems(q.q);
      if (stems.length) order.unshift(desc(sql`(${and(...stems.map((w) => ilike(products.name, `%${w}%`)))})`));
    }

    const rows = await db
      .select({ p: products, brandName: brands.name })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(where)
      .orderBy(...order, asc(products.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);

    return {
      items: rows.map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
      total: count,
      page: q.page,
      pages: Math.ceil(count / q.limit),
      facets,
    };
  });

  app.get('/v1/search/suggest', async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    const [items, cats] = await Promise.all([
      db
        .select({ p: products, brandName: brands.name })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(and(eq(products.isActive, true), searchCondition(q)))
        .orderBy(desc(products.isBestseller), desc(products.ratingCount))
        .limit(6),
      db
        .select({ slug: categories.slug, name: categories.name })
        .from(categories)
        .where(and(eq(categories.isActive, true), ...searchStems(q).map((w) => ilike(categories.name, `%${w}%`))))
        .limit(3),
    ]);
    return {
      products: items.map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
      categories: cats,
    };
  });

  app.get('/v1/home', async () => {
    const [best, cats, slides, sections, brandRows] = await Promise.all([
      db
        .select({ p: products, brandName: brands.name })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(and(eq(products.isActive, true), eq(products.isBestseller, true), sql`${products.stockQty} > 0`))
        // a fresh random pick every time Home loads, so shoppers see different bestsellers
        .orderBy(sql`random()`)
        .limit(12),
      db
        .select()
        .from(categories)
        .where(and(eq(categories.isActive, true), sql`${categories.parentId} is null`))
        .orderBy(asc(categories.sort))
        .limit(8),
      db
        .select()
        .from(banners)
        .where(
          and(
            eq(banners.isActive, true),
            sql`(${banners.startsAt} is null or ${banners.startsAt} <= now())`,
            sql`(${banners.endsAt} is null or ${banners.endsAt} > now())`,
          ),
        )
        .orderBy(asc(banners.sort), asc(banners.id))
        .limit(10),
      homeSectionCards(db),
      // "Shop by brand": brands with something to show, most products first
      db
        .select({ slug: brands.slug, name: brands.name, logoUrl: brands.logoUrl, count: sql<number>`count(*)::int` })
        .from(products)
        .innerJoin(brands, eq(brands.id, products.brandId))
        .where(eq(products.isActive, true))
        .groupBy(brands.id)
        .orderBy(desc(sql`count(*)`), asc(brands.name))
        .limit(12),
    ]);
    return {
      bestsellers: best.map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
      categories: cats.map((c) => ({ slug: c.slug, name: c.name, imageUrl: c.imageUrl, tint: c.tint })),
      banners: await bannerCards(db, slides),
      sections,
      brands: brandRows,
    };
  });

  app.get('/v1/products/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(200) }), req.params);
    const [row] = await db
      .select({ p: products, brandName: brands.name, brandSlug: brands.slug, brandLogo: brands.logoUrl, categorySlug: categories.slug, categoryName: categories.name })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(and(eq(products.slug, slug), eq(products.isActive, true)));
    if (!row) throw new HttpError(404, 'not_found', 'This product is no longer available.');
    const p = row.p;

    const [variants, sameCategory, bought, reviews] = await Promise.all([
      p.variantGroup
        ? db
            .select()
            .from(products)
            .where(and(eq(products.variantGroup, p.variantGroup), eq(products.isActive, true)))
            .orderBy(asc(products.pricePaise))
        : Promise.resolve([]),
      // everything else listed in this product's category (not itself or its pack-size siblings)
      p.categoryId
        ? db
            .select({ p: products, brandName: brands.name, brandSlug: brands.slug, brandLogo: brands.logoUrl })
            .from(products)
            .leftJoin(brands, eq(brands.id, products.brandId))
            .where(
              and(
                inCategories(db, [p.categoryId]),
                ne(products.id, p.id),
                eq(products.isActive, true),
                p.variantGroup ? or(sql`${products.variantGroup} is null`, ne(products.variantGroup, p.variantGroup)) : undefined,
              ),
            )
            .limit(300)
        : Promise.resolve([]),
      alsoBought(db, p, 6),
      getSettings(db).then((s) => reviewSummary(db, p.id, { viewerId: req.auth ? Number(req.auth.sub) : null, words: s.writtenReviews })),
    ]);

    // A fresh pick on every visit (like Home's bestsellers), six each: two rows of three, like Blinkit's.
    // "Similar products": any 6 from the category; "Top products in this category": 6 of the rest, most
    // popular first.
    const mixed = shuffled(sameCategory);
    const similar = mixed.slice(0, 6);
    const top = mixed.slice(6, 12).sort(byPopularity);

    // "Brands in this category", most products first (this product's brand counts too)
    const brandCount = new Map<string, { slug: string; name: string; logoUrl: string | null; count: number }>();
    for (const r of [...sameCategory, { brandSlug: row.brandSlug, brandName: row.brandName, brandLogo: row.brandLogo }]) {
      if (!r.brandSlug || !r.brandName) continue;
      const b = brandCount.get(r.brandSlug) ?? { slug: r.brandSlug, name: r.brandName, logoUrl: r.brandLogo ?? null, count: 0 };
      b.count++;
      if (!b.logoUrl && r.brandLogo) b.logoUrl = r.brandLogo;
      brandCount.set(r.brandSlug, b);
    }

    return {
      ...productCard(p, row.brandName ? { name: row.brandName } : null),
      /** for the brand page (`?brand=` on the product list) */
      brandSlug: row.brandSlug,
      /** the brand's logo (set from Wall2Roof), for the "Explore all products" row */
      brandLogoUrl: row.brandLogo,
      images: p.images,
      description: htmlToText(p.description),
      specs: p.specs,
      returnable: p.returnable,
      returnDays: p.returnDays,
      category: row.categorySlug ? { slug: row.categorySlug, name: row.categoryName } : null,
      variants: variants.map((v) => ({
        slug: v.slug,
        label: v.variantLabel ?? v.name,
        pricePaise: v.pricePaise,
        inStock: v.stockQty > 0,
        selected: v.id === p.id,
      })),
      /** "Similar products": 6 from the same category, a different pick each visit */
      related: similar.map(card),
      /** "Top products in this category": 6 more from the category, most popular first */
      topInCategory: top.map(card),
      /** "People also bought" */
      alsoBought: bought.map(card),
      brandsInCategory: [...brandCount.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      /** "Ratings & reviews": the average, star counts and the latest reviews with words */
      reviews,
    };
  });
}
