import { and, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { productCategories, products } from '../db/schema.js';

/**
 * "Product is in one of these categories": its main category_id, or any of its extra categories in
 * product_categories. Reading both means a product still shows when a writer only set category_id.
 */
export function inCategories(db: Db, ids: number[]): SQL {
  return or(
    inArray(products.categoryId, ids),
    inArray(products.id, db.select({ id: productCategories.productId }).from(productCategories).where(inArray(productCategories.categoryId, ids))),
  )!;
}

const ELECTRICAL = /wire|cable|switch|socket|\bmcb|fuse|breaker|extension|plug|adapter|charger|\btools?\b|tester|conduit|\btape/i;
const LIGHTING = /light|lamp|bulb|chandelier|strip|tube|batten|downlight|\bpanel|\bled\b|spot/i;

/**
 * The broad kind of a category, from its name (or its parent's): wires and switches are "electrical",
 * anything that lights up is "lighting". Used to fill "People also bought" with related products.
 */
export function categoryKind(...names: (string | null | undefined)[]): 'electrical' | 'lighting' | null {
  for (const n of names) {
    if (!n) continue;
    if (ELECTRICAL.test(n)) return 'electrical';
    if (LIGHTING.test(n)) return 'lighting';
  }
  return null;
}

/** Active products per category id (main and extra categories), as sets so nothing is counted twice. */
export async function categoryMembers(db: Db): Promise<Map<number, Set<number>>> {
  const [main, extra] = await Promise.all([
    db
      .select({ productId: products.id, categoryId: products.categoryId })
      .from(products)
      .where(and(eq(products.isActive, true), isNotNull(products.categoryId))),
    db
      .select({ productId: productCategories.productId, categoryId: productCategories.categoryId })
      .from(productCategories)
      .innerJoin(products, eq(products.id, productCategories.productId))
      .where(eq(products.isActive, true)),
  ]);
  const members = new Map<number, Set<number>>();
  for (const r of [...main, ...extra]) {
    if (r.categoryId == null) continue;
    const set = members.get(r.categoryId) ?? new Set<number>();
    set.add(r.productId);
    members.set(r.categoryId, set);
  }
  return members;
}

/** Distinct products in a category and everything under it (a product in two sub-categories counts once). */
export function subtreeCount(id: number, members: Map<number, Set<number>>, kids: Map<number, number[]>): number {
  const all = new Set<number>();
  const stack = [id];
  const seen = new Set<number>();
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue; // a broken parent loop can't hang the request
    seen.add(c);
    for (const p of members.get(c) ?? []) all.add(p);
    stack.push(...(kids.get(c) ?? []));
  }
  return all.size;
}

/**
 * Sets a product's categories: the first is the main one (products.category_id), the list replaces
 * its set, and an empty list clears both. Run inside the caller's transaction.
 */
export async function setProductCategories(tx: Pick<Db, 'update' | 'delete' | 'insert'>, productId: number, ids: number[]) {
  await tx.update(products).set({ categoryId: ids[0] ?? null }).where(eq(products.id, productId));
  await tx.delete(productCategories).where(eq(productCategories.productId, productId));
  if (ids.length) await tx.insert(productCategories).values(ids.map((categoryId) => ({ productId, categoryId })));
}

/** Each product's categories, main first. */
export async function categoriesOf(db: Pick<Db, 'select'>, rows: { id: number; categoryId: number | null }[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>(rows.map((r) => [r.id, r.categoryId != null ? [r.categoryId] : []]));
  if (!rows.length) return out;
  const extra = await db
    .select({ productId: productCategories.productId, categoryId: productCategories.categoryId })
    .from(productCategories)
    .where(inArray(productCategories.productId, rows.map((r) => r.id)))
    .orderBy(productCategories.categoryId);
  for (const e of extra) {
    const list = out.get(e.productId);
    if (list && !list.includes(e.categoryId)) list.push(e.categoryId);
  }
  return out;
}
