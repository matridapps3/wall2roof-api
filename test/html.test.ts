import { describe, expect, it } from 'vitest';

import { htmlToText } from '../src/lib/html.js';

describe('htmlToText tables', () => {
  it('writes each row on one line under its header, like the website table', () => {
    // as Wall2Roof sends Philips' "Available Dimensions": every cell on its own source line, header in <strong>
    const html = `<p><strong>Available Dimensions:</strong></p>
<table>
<tbody>
<tr>
<td><strong>Wattage</strong></td>
<td><strong>Shape</strong></td>
<td><strong>Height</strong></td>
<td><strong>Length</strong></td>
<td><strong>Width</strong></td>
</tr>
<tr>
<td>6W</td>
<td>Round</td>
<td>2.9 cm</td>
<td>10.2 cm</td>
<td>10.2 cm</td>
</tr>
<tr>
<td>12W</td>
<td>Square</td>
<td>2.9 cm</td>
<td>14.5 cm</td>
<td>14.5 cm</td>
</tr>
</tbody>
</table>
<p>Upgrade your lighting.</p>`;
    expect(htmlToText(html)).toBe(
      [
        'Available Dimensions:',
        '',
        'Wattage · Shape · Height · Length · Width',
        '6W · Round · 2.9 cm · 10.2 cm · 10.2 cm',
        '12W · Square · 2.9 cm · 14.5 cm · 14.5 cm',
        '',
        'Upgrade your lighting.',
      ].join('\n'),
    );
  });

  it('uses <th> cells as the header', () => {
    expect(htmlToText('<table><tr><th>Pack</th><th>Price</th></tr><tr><td>1</td><td>&#8377;99</td></tr></table>')).toBe('Pack · Price\n1 · ₹99');
  });

  it('reads a two-column table without a header as "Label: value"', () => {
    expect(htmlToText('<table><tr><td>Brand</td><td>Philips</td></tr><tr><td>Warranty</td><td>2 years</td></tr></table>')).toBe('Brand: Philips\nWarranty: 2 years');
  });

  it('keeps "<" and "&" written in cells', () => {
    expect(htmlToText('<table><tr><td>Power</td><td>&lt;5W &amp; dimmable</td></tr></table>')).toBe('Power: <5W & dimmable');
  });

  it('leaves text without tables as before', () => {
    expect(htmlToText('<p>Bright <b>cool day</b> light.</p><ul><li>15,000 hours</li></ul>')).toBe('Bright cool day light.\n\n• 15,000 hours');
  });
});
