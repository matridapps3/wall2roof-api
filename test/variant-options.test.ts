import { describe, expect, it } from 'vitest';

import { baseName, buildOptions, optionValues, type OptionCandidate } from '../src/lib/variant-options.js';

const spec = (label: string, value: string) => ({ label, value });

let nextId = 1;
const wire = (name: string, mm: string, colour: string, length: string, pricePaise: number, inStock = true): OptionCandidate => ({
  id: nextId++,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  specs: [spec('Brand', 'V-Guard'), spec('Length', length), spec('Conductor Nominal Area', mm), spec('MM', mm), spec('Colour', colour), spec('Weight', '1 kg')],
  pricePaise,
  inStock,
});

// the real names and specs of products in the catalogue
const classio1Red = wire('V-GUARD CLASSIO PLUS TRIPLE LAYER PVC INSULATED WIRING CABLE 90 MTRS 1 mm²-Red', '1 mm²', 'Red', '90 meter', 223000);
const classio25Yellow = wire('V-GUARD CLASSIO PLUS TRIPLE LAYER PVC INSULATED WIRING CABLE 90 MTRS 2.5 mm²-Yellow', '2.5 mm²', 'Yellow', '90 meter', 524000);
const classio1Yellow = wire('V-GUARD CLASSIO PLUS TRIPLE LAYER PVC INSULATED WIRING CABLE 90 MTRS 1 mm²-Yellow', '1 mm²', 'Yellow', '90 meter', 223000, false);
const frlsh = wire('V-GUARD FRLSH HOUSE WIRING CABLE 180METER 4SQ.MM-Yellow', '4 mm²', 'Yellow', '180 meter', 1678000);

const light = (name: string, w: string, body: string, lightColour: string): OptionCandidate => ({
  id: nextId++,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  specs: [spec('Wattage', w), spec('Light Color', lightColour), spec('Body Color', body), spec('Country of Origin', 'India')],
  pricePaise: 118000,
  inStock: true,
});

describe('product options (Wall2Roof-style variants)', () => {
  it('reads the option values from the specs Wall2Roof sends', () => {
    expect(optionValues(classio1Red.specs)).toEqual({ size: '1 mm²', colour: 'Red', length: '90 meter' });
    expect(optionValues([spec('Wattage', '7W'), spec('Body Color', 'Black'), spec('Light Color', 'Warm White')])).toEqual({
      wattage: '7W',
      colour: 'Black',
      light: 'Warm White',
    });
    expect(optionValues([spec('Material', 'Metal')])).toEqual({});
  });

  it('gives sizes and colours of one product line the same base name', () => {
    const a = baseName(classio1Red.name, optionValues(classio1Red.specs));
    expect(a).toBe('v guard classio plus triple layer pvc insulated wiring cable');
    expect(baseName(classio25Yellow.name, optionValues(classio25Yellow.specs))).toBe(a);
    expect(baseName(frlsh.name, optionValues(frlsh.specs))).toBe('v guard frlsh house wiring cable');
    const glide7 = light('Philips GlideSpot LED COB Light - 7W / Black / Warm White 929003640501', '7W', 'Black', 'Warm White');
    const glide12 = light('Philips GlideSpot LED COB Light - 12W / Rose Gold / Natural White 929003640901', '12W', 'Rose Gold', 'Natural White');
    expect(baseName(glide7.name, optionValues(glide7.specs))).toBe('philips glidespot led cob light');
    expect(baseName(glide12.name, optionValues(glide12.specs))).toBe('philips glidespot led cob light');
  });

  it('builds the size and colour buttons from the siblings, ignoring other product lines', () => {
    const o = buildOptions(classio1Red, [classio25Yellow, classio1Yellow, frlsh]);
    expect(o?.attributes).toEqual([
      { key: 'size', name: 'Size', kind: 'chips', values: ['1 mm²', '2.5 mm²'] },
      { key: 'colour', name: 'Colour', kind: 'colour', values: ['Red', 'Yellow'] },
      { key: 'length', name: 'Length', kind: 'chips', values: ['90 meter'] },
    ]);
    expect(o?.items.map((i) => [i.slug, i.values.size, i.values.colour, i.selected, i.inStock])).toEqual([
      [classio1Red.slug, '1 mm²', 'Red', true, true],
      [classio25Yellow.slug, '2.5 mm²', 'Yellow', false, true],
      [classio1Yellow.slug, '1 mm²', 'Yellow', false, false],
    ]);
  });

  it('shows nothing for a product with no siblings or no option specs', () => {
    expect(buildOptions(frlsh, [classio1Red, classio25Yellow])).toBeNull();
    const plain = { ...frlsh, id: 999, specs: [spec('Material', 'Metal')] };
    expect(buildOptions(plain, [frlsh])).toBeNull();
  });

  it('keeps one product per combination and sorts sizes by number', () => {
    const dup = { ...classio25Yellow, id: 500, slug: 'dup', pricePaise: 600000 };
    const small = wire('V-GUARD CLASSIO PLUS TRIPLE LAYER PVC INSULATED WIRING CABLE 90 MTRS 0.75 mm²-Red', '0.75 mm²', 'Red', '90 meter', 180000);
    const big = wire('V-GUARD CLASSIO PLUS TRIPLE LAYER PVC INSULATED WIRING CABLE 90 MTRS 10 mm²-Red', '10 mm²', 'Red', '90 meter', 1800000);
    const o = buildOptions(classio1Red, [big, dup, classio25Yellow, small]);
    expect(o?.attributes[0].values).toEqual(['0.75 mm²', '1 mm²', '2.5 mm²', '10 mm²']);
    expect(o?.items.filter((i) => i.values.size === '2.5 mm²').map((i) => i.slug)).toEqual([classio25Yellow.slug]); // the cheaper one
  });
});
