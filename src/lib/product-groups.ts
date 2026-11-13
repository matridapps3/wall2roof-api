import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { productGroupItems, productGroups, products, type GroupOption } from '../db/schema.js';

/**
 * Product options ("Size 1 / 2.5", "Colour Red / Yellow", "Length 90 m") from the SKU groups the owner
 * publishes from Wall2Roof's SKU Group screen. Wall2Roof decides which products belong together and
 * which options to show; a product in no published group has no options.
 */

export type OptionKind = 'chips' | 'colour';

export type ProductOptions = {
  /** each option with its values in display order, e.g. Size: ['1 mm²', '2.5 mm²'] */
  attributes: { key: string; name: string; kind: OptionKind; values: string[] }[];
  /** every product in the group with its own values; the app finds the one to open from these */
  items: { slug: string; values: Record<string, string>; pricePaise: number; inStock: boolean; selected: boolean }[];
};

/**
 * Wall2Roof keys the app knows by a fixed key: it writes "Size (sq mm)" with plain numbers for mm² sizes,
 * "90 m" for lengths, and colour swatches. Every other option keeps Wall2Roof's own key and name.
 */
const KNOWN: { key: string; name: string; kind: OptionKind; from: string[] }[] = [
  { key: 'size', name: 'Size', kind: 'chips', from: ['mm', 'size', 'conductor_nominal_area', 'cable_size', 'wire_size'] },
  { key: 'wattage', name: 'Wattage', kind: 'chips', from: ['wattage', 'watt'] },
  { key: 'colour', name: 'Colour', kind: 'colour', from: ['colour', 'color', 'body_color', 'body_colour', 'wire_colour', 'wire_color'] },
  { key: 'light', name: 'Light colour', kind: 'chips', from: ['light_color', 'light_colour', 'colour_temperature', 'color_temperature'] },
  { key: 'length', name: 'Length', kind: 'chips', from: ['length', 'cable_length', 'wire_length', 'coil_length'] },
];

const slugKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** The group's options as the app shows them: `source` is Wall2Roof's key (the key of each SKU's values). */
export function appOptions(options: GroupOption[]): { source: string; key: string; name: string; kind: OptionKind }[] {
  const used = new Set<string>();
  return options.map((o) => {
    const known = KNOWN.find((k) => k.from.includes(slugKey(o.key)));
    // two Wall2Roof options for the same thing (Colour and Body colour): the second keeps its own name
    const asKnown = !!known && !used.has(known.key);
    const base = asKnown ? known.key : slugKey(o.key) || 'option';
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    return asKnown ? { source: o.key, key, name: known.name, kind: known.kind } : { source: o.key, key, name: o.name || o.key, kind: 'chips' };
  });
}

/** Natural order: numbers by size ("0.75 mm²" < "1 mm²" < "10 mm²"), words A–Z. */
export function compareValues(a: string, b: string): number {
  const na = Number(a.match(/\d+(?:\.\d+)?/)?.[0]);
  const nb = Number(b.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

const MAX_GROUP = 200;

/**
 * Values written differently only in capitals or spaces ("Natural white" / "Natural White") are one
 * choice: every product gets the spelling most of them use (on a tie, the one with more capitals),
 * so the same spelling shows on every page of the group.
 */
export function sameSpelling(members: { values: Record<string, string> }[], opts: { key: string }[]): void {
  for (const { key } of opts) {
    const spellings = new Map<string, Map<string, number>>();
    for (const m of members) {
      const v = m.values[key];
      if (!v) continue;
      const norm = v.toLowerCase().replace(/\s+/g, ' ');
      const counts = spellings.get(norm) ?? new Map<string, number>();
      counts.set(v, (counts.get(v) ?? 0) + 1);
      spellings.set(norm, counts);
    }
    const capitals = (s: string) => (s.match(/[A-Z]/g) ?? []).length;
    const pick = new Map(
      [...spellings].map(([norm, counts]) => [
        norm,
        [...counts].sort((a, b) => b[1] - a[1] || capitals(b[0]) - capitals(a[0]) || a[0].localeCompare(b[0]))[0][0],
      ]),
    );
    for (const m of members) {
      const v = m.values[key];
      if (v) m.values[key] = pick.get(v.toLowerCase().replace(/\s+/g, ' '))!;
    }
  }
}

/**
 * The options on a product's page and the SKUs of its group (lower case; kept out of "Similar
 * products"). Only active products count; a group needs two of them, differing on at least one option.
 */
export async function groupOptionsFor(db: Db, p: { id: number; sku: string }): Promise<{ options: ProductOptions | null; groupSkus: Set<string> }> {
  const none = { options: null, groupSkus: new Set<string>() };
  const [mine] = await db
    .select({ groupId: productGroupItems.groupId, options: productGroups.options })
    .from(productGroupItems)
    .innerJoin(productGroups, eq(productGroups.id, productGroupItems.groupId))
    .where(eq(productGroupItems.sku, p.sku.trim().toLowerCase()));
  if (!mine) return none;

  const items = await db.select({ sku: productGroupItems.sku, values: productGroupItems.values }).from(productGroupItems).where(eq(productGroupItems.groupId, mine.groupId));
  const groupSkus = new Set(items.map((i) => i.sku));
  const valuesBySku = new Map(items.map((i) => [i.sku, i.values]));
  const rows = await db
    .select({ id: products.id, sku: products.sku, slug: products.slug, pricePaise: products.pricePaise, stockQty: products.stockQty })
    .from(products)
    .where(and(inArray(sql`lower(${products.sku})`, [...groupSkus]), eq(products.isActive, true)));

  const opts = appOptions(mine.options);
  const members = rows.map((r) => {
    const raw = valuesBySku.get(r.sku.toLowerCase()) ?? {};
    const values: Record<string, string> = {};
    for (const o of opts) {
      const v = raw[o.source]?.trim();
      if (v) values[o.key] = v;
    }
    return { r, values, inStock: r.stockQty > 0 };
  });
  const current = members.find((m) => m.r.id === p.id);
  if (!current) return { options: null, groupSkus };
  sameSpelling(members, opts);

  // Two products with exactly the same options can't be told apart: keep the open one, else the
  // in-stock / cheaper one.
  const bySignature = new Map<string, (typeof members)[number]>();
  for (const m of members) {
    const sig = opts.map((o) => (m.values[o.key] ?? '').toLowerCase()).join('|');
    const had = bySignature.get(sig);
    const better =
      !had ||
      m === current ||
      (had !== current && ((m.inStock && !had.inStock) || (m.inStock === had.inStock && m.r.pricePaise < had.r.pricePaise)));
    if (better) bySignature.set(sig, m);
  }
  const group = [...bySignature.values()].slice(0, MAX_GROUP);
  if (!group.includes(current)) group.push(current);
  if (group.length < 2) return { options: null, groupSkus };

  const attributes = opts.flatMap((o) => {
    const values = [...new Set(group.map((m) => m.values[o.key]).filter((v): v is string => !!v))].sort(compareValues);
    // shown when the products differ on it, or as plain information when the open one has it
    return values.length && (values.length > 1 || current.values[o.key]) ? [{ key: o.key, name: o.name, kind: o.kind, values }] : [];
  });
  if (!attributes.some((a) => a.values.length > 1)) return { options: null, groupSkus };

  return {
    groupSkus,
    options: {
      attributes,
      items: group.map((m) => ({
        slug: m.r.slug,
        values: Object.fromEntries(attributes.flatMap((a) => (m.values[a.key] ? [[a.key, m.values[a.key]]] : []))),
        pricePaise: m.r.pricePaise,
        inStock: m.inStock,
        selected: m === current,
      })),
    },
  };
}
