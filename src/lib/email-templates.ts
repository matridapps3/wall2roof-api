import { esc } from './html.js';

/**
 * Building blocks for the staff alert emails (lib/mailer.ts). Email clients are not browsers: Gmail
 * drops <style> in many cases, so every style is inline, the layout is tables, and there are no
 * outside fonts, CSS or scripts. The two small <style> blocks (phones, dark mode) are extras only.
 *
 * Every helper here that takes `text` escapes it; a parameter typed `Html` must already be safe
 * (built here, with each customer or product string passed through esc()).
 */
export type Html = string;

/** The app's colours (mobile/src/theme/tokens.ts). */
export const C = {
  navy: '#0F2747',
  navySoft: '#1B3A63',
  primary: '#0B5FA5',
  sky: '#5AA9F0',
  skySoft: '#EAF2FD',
  skyTint: '#F2F7FE',
  text: '#0F2747',
  muted: '#5B6B82',
  subtle: '#7D8A9C',
  page: '#F5F7FA',
  card: '#FFFFFF',
  border: '#E4E7EC',
  borderStrong: '#CBD2DC',
  success: '#12805C',
  successSoft: '#E7F5EF',
  danger: '#C8232B',
  dangerSoft: '#FDECEC',
  warning: '#B7791F',
  warningSoft: '#FDF6E7',
  amber: '#E3A008',
} as const;

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** Set again on each text cell: some clients don't pass the font into tables. */
const F = `font-family:${FONT}`;
/** Light text on the navy banner. */
const ON_NAVY_MUTED = '#B8C7DB';

// ---- Safe links: only ever built from checked parts, then escaped like any attribute ----

/** A phone number as typed, reduced to its digits (a leading + kept); null unless it is 6–15 digits of phone characters. */
function phoneDigits(raw: string | null | undefined): string | null {
  const t = raw?.trim();
  if (!t || !/^\+?[\d\s().-]+$/.test(t)) return null;
  const d = t.replace(/\D/g, '');
  if (d.length < 6 || d.length > 15) return null;
  return (t.startsWith('+') ? '+' : '') + d;
}

/** The 10 digits of an Indian mobile number ("98765 43210", "+91 98765 43210", "098765 43210"), else null. */
export function indianMobile(raw: string | null | undefined): string | null {
  const p = phoneDigits(raw);
  if (!p) return null;
  const d = p.replace(/^\+/, '');
  const ten = p.startsWith('+') ? (d.startsWith('91') ? d.slice(2) : '') : d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

/** tel: link (digits and a leading + only), or null when it isn't a phone number. */
export function telHref(raw: string | null | undefined): string | null {
  const m = indianMobile(raw);
  if (m) return `tel:+91${m}`;
  const p = phoneDigits(raw);
  return p ? `tel:${p}` : null;
}

/** WhatsApp chat link, for an Indian mobile number only. */
export function waHref(raw: string | null | undefined): string | null {
  const m = indianMobile(raw);
  return m ? `https://wa.me/91${m}` : null;
}

/** "98765 43210" for an Indian mobile number, else the number as typed. */
export function showPhone(raw: string): string {
  const m = indianMobile(raw);
  return m ? `${m.slice(0, 5)} ${m.slice(5)}` : raw.trim();
}

/** Two phone numbers that ring the same phone. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = indianMobile(a) ?? phoneDigits(a);
  return !!x && x === (indianMobile(b) ?? phoneDigits(b));
}

/** A plain address: no spaces, quotes, brackets or URL characters that could change the link. */
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?#&%/]+@[^\s@<>()[\]\\,;:"?#&%/'.]+(\.[^\s@<>()[\]\\,;:"?#&%/'.]+)+$/;

/** mailto: link for a valid email address, with an optional subject; else null. */
export function mailtoHref(email: string | null | undefined, subject?: string): string | null {
  const e = email?.trim();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return `mailto:${e}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
}

/** The address when it is a well-formed https:// URL (never javascript:, data:, http:), else null. */
export function httpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// ---- Pieces ----

/** Customer or product text with its line breaks kept. */
export const lines = (text: string): Html => esc(text.replace(/\r\n?/g, '\n').trim()).replace(/\n/g, '<br>');

export function link(text: string, href: string): Html {
  return `<a href="${esc(href)}" class="ed-a" style="color:${C.primary};text-decoration:none;font-weight:600">${esc(text)}</a>`;
}

type ButtonKind = 'primary' | 'secondary' | 'whatsapp';
const BUTTON: Record<ButtonKind, string> = {
  primary: `background:${C.primary};color:#FFFFFF;border:1px solid ${C.primary}`,
  secondary: `background:${C.card};color:${C.primary};border:1px solid ${C.borderStrong}`,
  whatsapp: `background:${C.success};color:#FFFFFF;border:1px solid ${C.success}`,
};

/** A big tappable button (full width on phones when the client reads the <style>). */
export function button(text: string, href: string, kind: ButtonKind = 'secondary'): Html {
  return `<a href="${esc(href)}" class="ed-btn${kind === 'secondary' ? ' ed-btn2' : ''}" style="display:inline-block;${BUTTON[kind]};${F};font-size:15px;font-weight:700;line-height:20px;text-decoration:none;text-align:center;padding:12px 20px;border-radius:10px;margin:0 8px 8px 0">${esc(text)}</a>`;
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'dark';
const PILL: Record<Tone, [bg: string, fg: string, dot: string | null]> = {
  success: [C.successSoft, C.success, null],
  warning: [C.warningSoft, C.text, C.amber],
  danger: [C.dangerSoft, C.danger, null],
  info: [C.skySoft, C.primary, null],
  neutral: [C.border, C.text, null],
  dark: [C.navySoft, '#FFFFFF', null],
};

/** A rounded label; `dot` adds a coloured dot before it. */
export function pill(text: string, tone: Tone, dot?: string): Html {
  const [bg, fg, toneDot] = PILL[tone];
  const d = dot ?? toneDot;
  return `<span${tone === 'dark' ? ' class="ed-pd"' : ''} style="display:inline-block;background:${bg};color:${fg};${F};font-size:13px;font-weight:700;line-height:18px;padding:5px 12px;border-radius:999px;margin:0 6px 6px 0;white-space:nowrap">${d ? `<span style="color:${d}">&#9679;</span>&nbsp;` : ''}${esc(text)}</span>`;
}

/** Small capitals over a section. */
export function overline(text: string, color: string = C.muted): Html {
  return `<div class="${color === C.muted ? 'ed-m' : ''}" style="${F};font-size:11px;font-weight:700;line-height:16px;letter-spacing:0.8px;text-transform:uppercase;color:${color};margin:0 0 8px">${esc(text)}</div>`;
}

/** A row of the card: padding, a line above, and an optional title. */
export function section(title: string | null, inner: Html, opts: { tint?: boolean; padding?: string } = {}): Html {
  const bg = opts.tint ? `background:${C.skyTint};` : '';
  return `<tr><td class="ed-p ed-line ed-t${opts.tint ? ' ed-tint' : ''}" style="${bg}padding:${opts.padding ?? '20px 24px'};border-top:1px solid ${C.border};${F};font-size:15px;line-height:22px;color:${C.text}">${title ? overline(title) : ''}${inner}</td></tr>`;
}

/** Two blocks side by side on a wide screen that stack on a phone, without needing <style>. */
export function columns(left: Html, right: Html): Html {
  const col = (html: Html, pad: string) =>
    `<div style="display:inline-block;vertical-align:top;width:100%;max-width:274px;font-size:15px;line-height:22px"><div style="padding:${pad}">${html}</div></div>`;
  return `<div style="font-size:0;line-height:0">${col(left, '0 16px 16px 0')}${col(right, '0 0 4px 0')}</div>`;
}

/** Label / value rows (the bill, the customer's details). */
export function rows(items: { label: Html; value: Html; strong?: boolean; color?: string }[], opts: { labelWidth?: number; valueAlign?: 'left' | 'right' } = {}): Html {
  const align = opts.valueAlign ?? 'right';
  const body = items
    .map(({ label, value, strong, color }) => {
      const top = strong ? `border-top:1px solid ${C.border};padding-top:12px;` : '';
      const size = strong ? 'font-size:17px;font-weight:800;' : 'font-size:15px;';
      const lc = strong ? `color:${C.text}` : `color:${C.muted}`;
      return `<tr><td valign="top" class="${strong ? 'ed-t' : 'ed-m'} ed-line" style="${top}padding-bottom:6px;${F};${size}line-height:22px;${lc}"${opts.labelWidth ? ` width="${opts.labelWidth}"` : ''}>${label}</td><td valign="top" align="${align}" class="${color === C.success ? 'ed-good' : color ? '' : 'ed-t'} ed-line" style="${top}padding-bottom:6px;padding-left:12px;${F};${size}line-height:22px;color:${color ?? C.text};word-break:break-word">${value}</td></tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">${body}</table>`;
}

/** The ElectroDash wordmark as in the app: "electro" + "dash" on a blue tile. Text, so nothing to download. */
const LOGO = `<span class="ed-ink" style="${F};font-size:22px;font-weight:800;line-height:30px;color:${C.navy};letter-spacing:-0.2px">electro</span><span style="${F};font-size:22px;font-weight:800;line-height:30px;color:#FFFFFF;background:${C.primary};border-radius:5px;padding:1px 5px 2px;margin-left:2px;letter-spacing:-0.2px">dash</span>`;

/** The navy band at the top of the card. */
export function banner(inner: Html): Html {
  return `<tr><td class="ed-p ed-ban" style="background:${C.navy};border-radius:15px 15px 0 0;padding:24px;${F};color:#FFFFFF">${inner}</td></tr>`;
}

export const bannerText = {
  overline: (text: string) => overline(text, C.sky),
  title: (text: string, size = 24) => `<div style="${F};font-size:${size}px;font-weight:800;line-height:${size + 6}px;color:#FFFFFF;word-break:break-word">${esc(text)}</div>`,
  small: (text: string) => `<div style="${F};font-size:13px;line-height:20px;color:${ON_NAVY_MUTED};margin-top:2px">${esc(text)}</div>`,
};

/** Phones and dark mode, for the clients that read <style>; everything works without it. */
const MOBILE_CSS = `@media only screen and (max-width:480px){.ed-out{padding:12px 8px !important}.ed-p{padding-left:16px !important;padding-right:16px !important}.ed-btn{display:block !important;margin:0 0 8px 0 !important}.ed-big{font-size:34px !important;line-height:40px !important}}`;
const DARK_CSS = `@media (prefers-color-scheme:dark){.ed-bg{background:#0B1220 !important}.ed-card{background:#131D2E !important;border-color:#26344B !important}.ed-line{border-color:#26344B !important}.ed-t{color:#E8EEF7 !important}.ed-m{color:#9AA9BD !important}.ed-a{color:#8CC4FF !important}.ed-ink{color:#FFFFFF !important}.ed-tint{background:#18263B !important}.ed-ban{background:#173A66 !important}.ed-btn2{background:#18263B !important;color:#E8EEF7 !important;border-color:#34465F !important}.ed-chip{background:#2B2414 !important;border-color:#5A4A22 !important;color:#F5E6C4 !important}.ed-quote{background:#18263B !important;color:#E8EEF7 !important}.ed-good{color:#4CC38A !important}.ed-pd{background:#2A5288 !important}}`;

/** The whole email: grey page, the logo, a white rounded card of rows, and a footer under it. */
export function emailPage(p: { title: string; tag: string; rows: Html[]; footer: Html }): Html {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(p.title)}</title>
<style>${MOBILE_CSS}</style>
<style>${DARK_CSS}</style>
</head>
<body class="ed-bg" style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ed-bg" style="background:${C.page}"><tr><td align="center" class="ed-out" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 4px 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">${LOGO}</td><td valign="middle" align="right" class="ed-m" style="${F};font-size:12px;font-weight:700;line-height:16px;letter-spacing:0.8px;text-transform:uppercase;color:${C.muted}">${esc(p.tag)}</td></tr></table></td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ed-card" style="background:${C.card};border:1px solid ${C.border};border-radius:16px;border-collapse:separate">
${p.rows.join('\n')}
</table></td></tr>
<tr><td class="ed-m" style="padding:16px 12px 0;${F};font-size:12px;line-height:18px;color:${C.subtle};text-align:center">${p.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
