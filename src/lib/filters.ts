import type { Spec } from '../db/schema.js';

/** Price ranges offered in the filter (paise; max is exclusive), like Blinkit's "Below ₹99" / "₹100 - ₹199". */
export const PRICE_BUCKETS = [
  { key: 'u500', label: 'Below ₹500', min: 0, max: 50_000 },
  { key: '500-999', label: '₹500 - ₹999', min: 50_000, max: 100_000 },
  { key: '1k-5k', label: '₹1,000 - ₹4,999', min: 100_000, max: 500_000 },
  { key: '5k-20k', label: '₹5,000 - ₹19,999', min: 500_000, max: 2_000_000 },
  { key: '20k+', label: '₹20,000 and above', min: 2_000_000, max: Number.POSITIVE_INFINITY },
];

/**
 * Product details offered as filter groups (Blinkit's "Country Of Origin", "Type"...), each reading
 * the spec labels the catalogue uses for it. Labels are matched case-insensitively.
 */
export const SPEC_GROUPS = [
  { key: 'origin', name: 'Country of Origin', labels: ['country of origin'] },
  { key: 'light', name: 'Light colour', labels: ['light color', 'light colour', 'colour temperature', 'color temperature'] },
  { key: 'colour', name: 'Colour', labels: ['body color', 'body colour', 'colour', 'color'] },
  { key: 'wattage', name: 'Wattage', labels: ['wattage', 'power'] },
  { key: 'material', name: 'Material', labels: ['material', 'body material'] },
  { key: 'shape', name: 'Shape', labels: ['shape'] },
  { key: 'bulb', name: 'Bulb type', labels: ['bulb type', 'type of bulb', 'bulb base'] },
];

export type FilterRow = { id: number; pricePaise: number; specs: Spec[]; brandSlug: string | null; brandName: string | null; brandLogo?: string | null };

/** What the shopper ticked: brand slugs, price bucket keys, and per spec group the (normalised) values. */
export type Picked = { brands: string[]; prices: string[]; specs: Record<string, string[]> };

export type Facets = {
  /** logoUrl: for the brand tiles on Home's category tabs */
  brands: { slug: string; name: string; logoUrl: string | null; count: number }[];
  prices: { key: string; label: string; count: number }[];
  specs: { key: string; name: string; options: { value: string; label: string; count: number }[] }[];
};

const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
/** Long or bracketed values ("3 × 6W G9 LED bulbs (included)") make poor filter options. */
const usable = (v: string) => v.trim().length > 0 && v.trim().length <= 24 && !/[()]/.test(v);

const asList = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Reads ?brand=, ?price= and ?spec= ("group:value", repeated). Brand and price also accept
 * comma-separated lists; spec values can contain commas, so they are only ever repeated.
 */
export function parsePicked(q: { brand?: string | string[]; price?: string | string[]; spec?: string | string[] }): Picked {
  const specs: Record<string, string[]> = {};
  for (const s of asList(q.spec)) {
    const i = s.indexOf(':');
    const key = s.slice(0, i);
    if (i < 1 || !SPEC_GROUPS.some((g) => g.key === key)) continue;
    (specs[key] ??= []).push(norm(s.slice(i + 1)));
  }
  return {
    brands: asList(q.brand).flatMap((b) => b.split(',')).filter(Boolean),
    prices: asList(q.price).flatMap((p) => p.split(',')).filter((k) => PRICE_BUCKETS.some((b) => b.key === k)),
    specs,
  };
}

export function isFiltering(p: Picked) {
  return p.brands.length > 0 || p.prices.length > 0 || Object.values(p.specs).some((v) => v.length);
}

function groupValues(row: FilterRow, labels: string[]) {
  return row.specs.filter((s) => s.value && labels.includes(norm(s.label))).map((s) => s.value);
}

/**
 * Applies the ticked filters to the products the category/search allows, and counts each option.
 * Ticks within a group widen the results (any of them); groups narrow each other. Each group's
 * counts take every other group into account but not its own ticks, so its options stay choosable.
 */
export function facetAndFilter(rows: FilterRow[], picked: Picked): { ids: number[]; facets: Facets } {
  const tests: Record<string, (r: FilterRow) => boolean> = {
    brand: (r) => !picked.brands.length || (r.brandSlug != null && picked.brands.includes(r.brandSlug)),
    price: (r) =>
      !picked.prices.length || PRICE_BUCKETS.some((b) => picked.prices.includes(b.key) && r.pricePaise >= b.min && r.pricePaise < b.max),
  };
  for (const g of SPEC_GROUPS) {
    const want = picked.specs[g.key] ?? [];
    tests[`spec:${g.key}`] = (r) => !want.length || groupValues(r, g.labels).some((v) => want.includes(norm(v)));
  }
  const entries = Object.entries(tests);
  const poolWithout = (skip: string | null) => rows.filter((r) => entries.every(([k, t]) => k === skip || t(r)));

  const brandCounts = new Map<string, Facets['brands'][number]>();
  for (const r of poolWithout('brand')) {
    if (!r.brandSlug) continue;
    const b = brandCounts.get(r.brandSlug) ?? { slug: r.brandSlug, name: r.brandName ?? r.brandSlug, logoUrl: r.brandLogo ?? null, count: 0 };
    b.count++;
    brandCounts.set(r.brandSlug, b);
  }
  // a ticked brand stays listed (at 0) when other filters leave it with nothing
  for (const slug of picked.brands) {
    const r = brandCounts.has(slug) ? undefined : rows.find((x) => x.brandSlug === slug);
    if (r) brandCounts.set(slug, { slug, name: r.brandName ?? slug, logoUrl: r.brandLogo ?? null, count: 0 });
  }

  const pricePool = poolWithout('price');
  const prices = PRICE_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: pricePool.filter((r) => r.pricePaise >= b.min && r.pricePaise < b.max).length,
  })).filter((b) => b.count > 0 || picked.prices.includes(b.key));

  const specs: Facets['specs'] = [];
  for (const g of SPEC_GROUPS) {
    const pool = poolWithout(`spec:${g.key}`);
    const want = picked.specs[g.key] ?? [];
    // value -> how many products, and the most common spelling to show
    const opts = new Map<string, { count: number; spellings: Map<string, number> }>();
    for (const r of pool) {
      const seen = new Set<string>();
      for (const raw of groupValues(r, g.labels)) {
        if (!usable(raw)) continue;
        const v = norm(raw);
        if (seen.has(v)) continue;
        seen.add(v);
        const o = opts.get(v) ?? { count: 0, spellings: new Map() };
        o.count++;
        o.spellings.set(raw.trim(), (o.spellings.get(raw.trim()) ?? 0) + 1);
        opts.set(v, o);
      }
    }
    for (const v of want) if (!opts.has(v)) opts.set(v, { count: 0, spellings: new Map([[v, 1]]) });
    const options = [...opts.entries()]
      .map(([value, o]) => ({ value, label: [...o.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0], count: o.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    // A group is only worth showing when it can narrow the list down (or something in it is ticked).
    const narrows = options.length > 1 || (options.length === 1 && options[0].count < pool.length);
    if (narrows || want.length) specs.push({ key: g.key, name: g.name, options });
  }

  return {
    ids: poolWithout(null).map((r) => r.id),
    facets: {
      brands: [...brandCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      prices,
      specs,
    },
  };
}
