import type { Spec } from '../db/schema.js';

/**
 * Wall2Roof-style product options ("MM 1.5 / 2.5 / 4", "Colour Red / Yellow", "Length 90 m / 180 m").
 *
 * Wall2Roof sends every size and colour as its own product (own SKU, price, stock, photos) and nothing
 * says which ones belong together. They are grouped here from their own data:
 *  - same brand and same main category, and
 *  - the same name once the product's own option values (size, wattage, colours, length) and any long
 *    model/SKU number are taken out of it, e.g.
 *    "V-GUARD CLASSIO PLUS … CABLE 90 MTRS 1 mm²-Red" and "… 90 MTRS 2.5 mm²-Yellow" → the same base name.
 * The option values come from the specs Wall2Roof already sends (MM, Wattage, Colour, Body Color,
 * Light Color, Length) — the same attributes its own website shows as options.
 */

export type OptionKind = 'chips' | 'colour';

type OptionDef = { key: string; name: string; labels: string[]; kind: OptionKind };

/** In the order they're shown. Labels are matched ignoring case and spaces. */
const OPTIONS: OptionDef[] = [
  { key: 'size', name: 'Size', labels: ['mm', 'size', 'conductor nominal area', 'wire size', 'cable size'], kind: 'chips' },
  { key: 'wattage', name: 'Wattage', labels: ['wattage', 'watt'], kind: 'chips' },
  { key: 'colour', name: 'Colour', labels: ['colour', 'color', 'body color', 'body colour', 'wire colour', 'wire color'], kind: 'colour' },
  { key: 'light', name: 'Light colour', labels: ['light color', 'light colour', 'colour temperature', 'color temperature'], kind: 'chips' },
  { key: 'length', name: 'Length', labels: ['length', 'cable length', 'coil length'], kind: 'chips' },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The product's option values, e.g. { size: '1 mm²', colour: 'Red', length: '90 meter' }. */
export function optionValues(specs: Spec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of OPTIONS) {
    // the first matching label in the definition's order wins ("MM" before "Conductor Nominal Area")
    for (const label of def.labels) {
      const s = specs.find((x) => norm(x.label) === label && x.value.trim());
      if (s) {
        out[def.key] = s.value.trim();
        break;
      }
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "1.5" not inside "11.5" or "1.55" */
const num = (n: string) => `(?<![\\d.])${escape(n)}(?![\\d])`;

const UNIT: Record<string, string> = {
  size: '\\s*(?:sq\\.?\\s*mm|sqmm|mm²|mm2|mm|sq)\\b',
  wattage: '\\s*(?:w|watts?)\\b',
  length: '\\s*(?:m|mtrs?|mts|meters?|metres?|mtr)\\b',
};

/** The name with this product's own option values and long model numbers removed (lower case). */
export function baseName(name: string, values: Record<string, string>): string {
  let s = ` ${name.toLowerCase()} `;
  for (const [key, value] of Object.entries(values)) {
    const n = value.match(/\d+(?:\.\d+)?/)?.[0];
    if (UNIT[key] && n) s = s.replace(new RegExp(num(n) + UNIT[key], 'gi'), ' ');
    // the value as written ("Rose Gold", "Warm White", "1 mm²")
    s = s.replace(new RegExp(`(?<![a-z0-9])${escape(value.toLowerCase())}(?![a-z0-9])`, 'g'), ' ');
  }
  return s
    .replace(/\b\d{6,}\b/g, ' ') // model / SKU numbers such as 929003640501
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type OptionCandidate = {
  id: number;
  slug: string;
  name: string;
  specs: Spec[];
  pricePaise: number;
  inStock: boolean;
};

export type ProductOptions = {
  /** each option with its values in display order, e.g. Size: ['1 mm²', '2.5 mm²'] */
  attributes: { key: string; name: string; kind: OptionKind; values: string[] }[];
  /** every product in the group with its own values; the app finds the one to open from these */
  items: { slug: string; values: Record<string, string>; pricePaise: number; inStock: boolean; selected: boolean }[];
};

const MAX_GROUP = 60;

/** Natural order: numbers by size ("0.75 mm²" < "1 mm²" < "10 mm²"), words A–Z. */
function compareValues(a: string, b: string): number {
  const na = Number(a.match(/\d+(?:\.\d+)?/)?.[0]);
  const nb = Number(b.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/**
 * The options to show on `current`'s page, from products of the same brand and main category
 * (`candidates`, which may include `current`). Null when it has no siblings.
 */
export function buildOptions(current: OptionCandidate, candidates: OptionCandidate[]): ProductOptions | null {
  const mine = optionValues(current.specs);
  if (!Object.keys(mine).length) return null;
  const key = baseName(current.name, mine);
  if (!key) return null;

  const members = [current, ...candidates.filter((c) => c.id !== current.id)]
    .map((c) => ({ c, values: c.id === current.id ? mine : optionValues(c.specs) }))
    .filter((m) => Object.keys(m.values).length && baseName(m.c.name, m.values) === key);

  // Two products with exactly the same options can't be told apart: keep the current one, else the
  // in-stock / cheaper one.
  const bySignature = new Map<string, (typeof members)[number]>();
  for (const m of members) {
    const sig = OPTIONS.map((d) => norm(m.values[d.key] ?? '')).join('|');
    const had = bySignature.get(sig);
    const better =
      !had ||
      m.c.id === current.id ||
      (had.c.id !== current.id && ((m.c.inStock && !had.c.inStock) || (m.c.inStock === had.c.inStock && m.c.pricePaise < had.c.pricePaise)));
    if (better) bySignature.set(sig, m);
  }
  const group = [...bySignature.values()].slice(0, MAX_GROUP);
  if (group.length < 2) return null;

  const attributes = OPTIONS.flatMap((d) => {
    const values = [...new Set(group.map((m) => m.values[d.key]).filter((v): v is string => !!v))].sort(compareValues);
    // shown when the products differ on it, or as plain information when the current one has it
    return values.length && (values.length > 1 || mine[d.key]) ? [{ key: d.key, name: d.name, kind: d.kind, values }] : [];
  });
  if (!attributes.some((a) => a.values.length > 1)) return null;

  return {
    attributes,
    items: group.map((m) => ({
      slug: m.c.slug,
      values: Object.fromEntries(attributes.flatMap((a) => (m.values[a.key] ? [[a.key, m.values[a.key]]] : []))),
      pricePaise: m.c.pricePaise,
      inStock: m.c.inStock,
      selected: m.c.id === current.id,
    })),
  };
}
