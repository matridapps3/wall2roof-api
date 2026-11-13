/** Text made safe to put in HTML (the web pages, staff emails). */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain readable text from product HTML (the app renders text, not HTML). */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', sup2: '²', deg: '°', times: '×', rupee: '₹',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A cell's text on one line. */
const cellText = (html: string) =>
  decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A table as text, one line per row, like the website shows it:
 *   Wattage · Shape · Height
 *   6W · Round · 2.9 cm
 * A two-column table without a header row reads as "Label: value".
 */
function tableToText(table: string): string {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((r) => [...r[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => ({ th: c[1].toLowerCase() === 'h', text: cellText(c[2]) })))
    .filter((cells) => cells.some((c) => c.text));
  if (!rows.length) return '\n';
  const [first, ...rest] = rows;
  // a header row: <th> cells, or (3+ columns) words over rows that hold numbers ("Wattage | Shape | Height"
  // over "6W | Round | 2.9 cm"); two columns of words are label / value rows instead
  const header =
    rest.length > 0 &&
    (first.every((c) => c.th) || (first.length > 2 && first.every((c) => !/\d/.test(c.text)) && rest.some((r) => r.some((c) => /\d/.test(c.text)))));
  const line = (cells: { text: string }[]) =>
    cells
      .map((c) => c.text)
      .filter(Boolean)
      .join(' · ');
  const lines = header
    ? [line(first), ...rest.map(line)]
    : rows.map((cells) => (cells.length === 2 && cells[0].text && cells[1].text ? `${cells[0].text}: ${cells[1].text}` : line(cells)));
  return `\n${lines.join('\n')}\n`;
}

export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  if (!/[<&]/.test(html)) return html.trim() || null;
  const text = decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      // tables first: their cells are often on separate source lines, which would each become a line
      .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (t) => tableToText(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'))
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}
