import { config } from '../config.js';
import type { AddressFields } from '../db/schema.js';
import {
  banner,
  bannerText,
  button,
  C,
  columns,
  emailPage,
  FONT,
  httpsUrl,
  lines,
  link,
  mailtoHref,
  overline,
  pill,
  rows,
  samePhone,
  section,
  showPhone,
  telHref,
  type Tone,
  waHref,
} from './email-templates.js';
import { esc } from './html.js';

/**
 * Email alerts to staff: each new order and each Contact us message. Sent over HTTPS with a plain
 * fetch (Railway blocks SMTP): through Resend's API, or through the mail relay on the Wall2Roof app
 * (Cloudways), which sends them with its own mailbox. Neither set up, or ALERT_EMAIL_TO unset = no email.
 */
export type Mail = { to: string[]; subject: string; text: string; html: string; replyTo?: string };
export type Mailer = { send(m: Mail): Promise<void> };
/** What the builders make; the recipients are always ALERT_EMAIL_TO. */
type Alert = Omit<Mail, 'to'>;

export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(m) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
      });
      if (!res.ok) throw new Error(`Resend error (${res.status}) ${(await res.text().catch(() => '')).slice(0, 300)}`);
    },
  };
}

/**
 * The Wall2Roof app's POST /api/electrodash/mail: it sends the email from its own MAIL_FROM_ADDRESS
 * and answers 202. Anything else (401, 422, 503, 502, a redirect) is an error. The key is never
 * put in the error.
 */
export function relayMailer(url: string, key: string): Mailer {
  // the key as sent, too: fetch drops whitespace (a pasted line break) from the end of a header
  const hide = (s: string) => [key, key.replace(/[\t\n\r ]+$/, '')].reduce((t, k) => (k ? t.split(k).join('[key]') : t), s);
  return {
    async send(m) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          // Accept: so Laravel answers errors as JSON rather than redirecting
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo ?? null }),
          // a redirect (say, to a login page) is not a sent email
          redirect: 'manual',
          // generous: Wall2Roof waits on GoDaddy's mail server before answering; never retried, so no double emails
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        // a key with a line break in it fails here with the whole header in the message, so the
        // original error (and its cause) is not passed on, only its text with the key taken out
        const err = e as Error | undefined;
        const cause = (err?.cause as Error | undefined)?.message;
        throw new Error(hide(`Mail relay unreachable: ${err?.message ?? String(e)}${cause ? ` (${cause})` : ''}`));
      }
      if (!res.ok) {
        // even an answer that echoes the key back can't put it in the log
        const body = hide(await res.text().catch(() => ''));
        throw new Error(`Mail relay error (${res.status}) ${body.slice(0, 300)}`);
      }
    },
  };
}

/** A well-formed https:// address (MAIL_RELAY_URL is only loosely checked at startup). */
function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The live mailer: Resend when RESEND_API_KEY is set, else the Wall2Roof relay when MAIL_RELAY_URL
 * (https only) and MAIL_RELAY_KEY are set. Null (no email) when neither is, when there are no
 * recipients, and in tests.
 */
export function defaultMailer(
  c: Pick<typeof config, 'isTest' | 'RESEND_API_KEY' | 'MAIL_FROM' | 'MAIL_RELAY_URL' | 'MAIL_RELAY_KEY' | 'alertEmailTo'> = config,
): Mailer | null {
  if (c.isTest || !c.alertEmailTo.length) return null;
  if (c.RESEND_API_KEY) return resendMailer(c.RESEND_API_KEY, c.MAIL_FROM);
  if (c.MAIL_RELAY_URL && isHttpsUrl(c.MAIL_RELAY_URL) && c.MAIL_RELAY_KEY) return relayMailer(c.MAIL_RELAY_URL.trim(), c.MAIL_RELAY_KEY);
  return null;
}

/**
 * Emails staff in the background: never awaited, so the customer's request can't fail or wait on
 * it. A failure is only logged.
 */
export function alertStaff(mailer: Mailer | null | undefined, build: () => Alert | Promise<Alert>, onError: (err: unknown) => void) {
  if (!mailer || !config.alertEmailTo.length) return;
  const m = mailer;
  void (async () => m.send({ to: config.alertEmailTo, ...(await build()) }))().catch(onError);
}

/** "₹1,234" or "₹1,234.50" (Indian digit grouping). */
export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const ist = (at: string | Date) => `${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;

const PAYMENT: Record<string, string> = { cod: 'Cash on delivery', online: 'Online' };
const PAYMENT_STATUS: Record<string, string> = {
  cod_due: 'To collect on delivery',
  pending: 'Not paid yet',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
};
/** Green only once the money is in: cash still to collect is amber, like an unpaid online order. */
const PAYMENT_TONE: Record<string, Tone> = { cod_due: 'warning', paid: 'success', pending: 'warning', failed: 'danger', refunded: 'neutral' };
/** As the app's Contact us page names them. */
const TOPIC: Record<string, string> = { order: 'Order issue', payment: 'Payment', delivery: 'Delivery', return: 'Return', product: 'Product', other: 'Other' };
/** Each topic's pill: its background and the colour of its dot. */
const TOPIC_PILL: Record<string, [Tone, string]> = {
  order: ['info', C.primary],
  payment: ['warning', C.amber],
  delivery: ['info', C.sky],
  return: ['danger', C.danger],
  product: ['success', C.success],
  other: ['neutral', C.subtle],
};
/** What the app's search sends for "Request this product". */
const PRODUCT_REQUEST = /^Product request from search:/;

/** A path on this server (e.g. /voice/12/<id>.m4a) as a full https:// address; null when the server has no public https address. */
function publicLink(path: string | null | undefined): string | null {
  if (!path || !config.publicUrl) return null;
  return httpsUrl(`${config.publicUrl}${path.startsWith('/') ? '' : '/'}${path}`);
}

/**
 * A product photo for the 56 px thumbnail. Photos stored on this server (…/img/<32 hex>.<type>, the
 * same rule as the app's sizedImage) load as the server's 160 px WebP, ~1–3 KB instead of the
 * 20–200 KB original, so a long order doesn't make the Gmail app download every full-size photo.
 * Gmail (web and apps) and Apple Mail show WebP; Outlook for Windows doesn't (no thumbnail there).
 */
const OWN_IMAGE = /\/img\/[a-f0-9]{32}\.(jpg|png|webp|gif|avif)$/;
function thumbnail(raw: string | null | undefined): string | null {
  const src = httpsUrl(raw);
  if (!src) return null;
  const u = new URL(src);
  return !u.search && !u.hash && OWN_IMAGE.test(u.pathname) ? `${src}?w=160` : src;
}
/**
 * Bytes of item rows the HTML may hold. Gmail cuts mail at ~102 KB ("[Message clipped]", hiding the
 * bill and everything under it) and the relay takes 200 KB. Rows are ~0.85 KB, so about 75 lines
 * fit; a bigger order lists the rest as one line pointing to the full list. The rest of the email
 * is at most ~22 KB, which keeps the whole HTML under ~90 KB.
 */
const ITEM_ROWS_BUDGET = 64 * 1024;

/** A date and time that doesn't break across lines (no "IST" alone on the last line). */
const istHtml = (at: string | Date) => `<span style="white-space:nowrap">${esc(ist(at))}</span>`;
const muted = (text: string) => `<span class="ed-m" style="color:${C.muted}">${esc(text)}</span>`;
const bold = (text: string, size = 16) => `<div style="font-size:${size}px;font-weight:700;line-height:${size + 6}px;word-break:break-word">${esc(text)}</div>`;
/** A phone number that rings when tapped (shown as typed when it isn't one). */
const phoneLink = (phone: string) => {
  const tel = telHref(phone);
  return tel ? link(showPhone(phone), tel) : esc(phone);
};

/** What the order email needs: the order as the order routes return it, after it is placed. */
export type OrderForMail = {
  number: string;
  placedAt: string;
  totalPaise: number;
  paymentMethod: string;
  paymentStatus: string;
  address: AddressFields;
  deliveryInstructions: string[];
  /** `image`: the product's photo when it was ordered (shown only when it is an https:// address) */
  items: { sku: string; name: string; qty: number; unitPricePaise: number; image?: string | null }[];
  bill: {
    subtotalPaise: number;
    deliveryFeePaise: number;
    handlingFeePaise: number;
    codFeePaise: number;
    discountPaise: number;
    couponCode: string | null;
    tipPaise: number;
    totalPaise: number;
  };
  gst: { gstin: string; businessName: string | null } | null;
  /** the recorded delivery instruction on this server, e.g. /voice/12/<id>.m4a (null when none) */
  voiceNote?: string | null;
};

export function newOrderMail(o: OrderForMail, customer: { name: string | null; phone: string | null }): Alert {
  const a = o.address;
  const method = PAYMENT[o.paymentMethod] ?? o.paymentMethod;
  const payment = `${method} · ${PAYMENT_STATUS[o.paymentStatus] ?? o.paymentStatus}`;
  const who = `${customer.name || 'No name'} · ${customer.phone || 'no phone'}`;
  const receiver = [a.name, a.phone].filter(Boolean).join(' · ');
  const cityLine = `${a.city}, ${a.state} ${a.pincode}`;
  const where = [a.line1, a.line2, a.landmark ? `Landmark: ${a.landmark}` : null, cityLine].filter((l): l is string => !!l);
  const map = Number.isFinite(a.lat) && Number.isFinite(a.lng) ? `https://www.google.com/maps?q=${a.lat},${a.lng}` : null;
  // no pin dropped: search the address instead
  const mapSearch = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([a.line1, a.line2, a.landmark, cityLine].filter(Boolean).join(', '))}`;
  const items = o.items.map((i) => ({ ...i, line: `${i.qty} × ${i.name} (SKU ${i.sku}) · ${rupees(i.unitPricePaise)} each · ${rupees(i.qty * i.unitPricePaise)}` }));
  const units = o.items.reduce((n, i) => n + i.qty, 0);
  // the bill as the app's order page shows it
  const b = o.bill;
  type BillLine = { label: string; value: string; code?: string; good?: boolean };
  const bill: BillLine[] = [{ label: 'Item total', value: rupees(b.subtotalPaise) }];
  if (b.handlingFeePaise) bill.push({ label: 'Handling charge', value: `+${rupees(b.handlingFeePaise)}` });
  bill.push(b.deliveryFeePaise ? { label: 'Delivery charges', value: `+${rupees(b.deliveryFeePaise)}` } : { label: 'Delivery charges', value: 'FREE', good: true });
  if (b.codFeePaise) bill.push({ label: 'Cash on delivery fee', value: `+${rupees(b.codFeePaise)}` });
  if (b.tipPaise) bill.push({ label: 'Delivery partner tip', value: `+${rupees(b.tipPaise)}` });
  if (b.discountPaise) bill.push({ label: 'Coupon discount', code: b.couponCode ?? undefined, value: `-${rupees(b.discountPaise)}`, good: true });
  bill.push({ label: 'Bill total', value: rupees(b.totalPaise) });
  const instructions = o.deliveryInstructions.join(', ');
  const gst = o.gst ? `${o.gst.gstin}${o.gst.businessName ? ` · ${o.gst.businessName}` : ''}` : null;
  const voice = publicLink(o.voiceNote);

  const text = [
    `New order ${o.number}`,
    `Placed ${ist(o.placedAt)}`,
    '',
    `Customer: ${who}`,
    '',
    'Deliver to',
    receiver,
    ...where,
    `Map: ${map ?? mapSearch}`,
    '',
    'Items',
    ...items.map((i) => i.line),
    '',
    'Bill',
    ...bill.map((l) => `${l.label}${l.code ? ` (${l.code})` : ''}: ${l.value}`),
    '',
    `Payment: ${payment}`,
    ...(instructions ? [`Delivery instructions: ${instructions}`] : []),
    ...(o.voiceNote ? [`Voice note: ${voice ?? 'recorded (play it on the admin’s order page)'}`] : []),
    ...(gst ? [`GSTIN: ${gst}`] : []),
  ].join('\n');

  // ---- HTML ----
  const payPill = o.paymentStatus === 'cod_due' ? `${method} · collect ${rupees(o.totalPaise)}` : payment;
  const top = banner(
    bannerText.overline('New order') +
      bannerText.title(o.number) +
      bannerText.small(`Placed ${ist(o.placedAt)}`) +
      `<div style="margin:18px 0 2px;font-size:12px;font-weight:700;line-height:16px;letter-spacing:0.8px;text-transform:uppercase;color:#B8C7DB">Total</div>` +
      `<div class="ed-big" style="font-size:40px;font-weight:800;line-height:46px;letter-spacing:-0.5px;color:#FFFFFF;margin:0 0 12px">${esc(rupees(o.totalPaise))}</div>` +
      `<div>${pill(payPill, PAYMENT_TONE[o.paymentStatus] ?? 'neutral')}${pill(`${units} item${units === 1 ? '' : 's'}`, 'dark')}</div>`,
  );

  const callCustomer = telHref(customer.phone);
  const callReceiver = samePhone(a.phone, customer.phone) ? null : telHref(a.phone);
  const actions = section(
    null,
    [
      callCustomer ? button('Call customer', callCustomer, 'primary') : '',
      callReceiver ? button('Call receiver', callReceiver, callCustomer ? 'secondary' : 'primary') : '',
      button('Open in Google Maps', map ?? mapSearch),
    ].join(''),
    { tint: true, padding: '16px 24px 8px' },
  );

  const customerCol =
    overline('Customer') + bold(customer.name || 'No name') + `<div>${customer.phone ? phoneLink(customer.phone) : muted('No phone')}</div>`;
  const deliverCol =
    overline('Deliver to') +
    bold(a.name) +
    `<div>${phoneLink(a.phone)}</div>` +
    `<div style="margin-top:6px;word-break:break-word">${[a.line1, a.line2].filter((l): l is string => !!l).map(esc).join('<br>')}` +
    (a.landmark ? `<br>${muted('Landmark:')} ${esc(a.landmark)}` : '') +
    `<br>${esc(cityLine)}</div>`;
  const people = section(null, columns(customerCol, deliverCol), { padding: '20px 24px 4px' });

  const chip = (t: string) =>
    `<span class="ed-chip" style="display:inline-block;background:${C.warningSoft};border:1px solid #EFDCAE;color:${C.text};font-size:14px;font-weight:600;line-height:20px;padding:6px 12px;border-radius:8px;margin:0 6px 6px 0">${esc(t)}</span>`;
  const notes =
    o.deliveryInstructions.length || o.voiceNote
      ? section(
          'Delivery instructions',
          (o.deliveryInstructions.length ? `<div>${o.deliveryInstructions.map(chip).join('')}</div>` : '') +
            (voice
              ? `<div style="margin-top:6px">${button('Play voice note', voice)}</div>`
              : o.voiceNote
                ? `<div style="margin-top:4px">${muted('Voice note recorded: play it on the admin’s order page.')}</div>`
                : ''),
          { padding: voice ? '20px 24px 12px' : '20px 24px 14px' },
        )
      : '';

  // Rows are kept small (a long order must stay under Gmail's ~102 KB): the font, size, colour and
  // word breaking are set once on the table and inherited, so each row only carries what differs.
  // A photo column only when some item has a photo; an item without one gets an empty tile.
  const thumbs = o.items.some((i) => thumbnail(i.image));
  const cols = thumbs ? 3 : 2;
  const itemRow = (i: OrderForMail['items'][number], first: boolean) => {
    const src = thumbnail(i.image);
    // a line between rows; the first row has none and no space above it
    const cell = (left = 0) => `class="ed-line" style="${first ? '' : `border-top:1px solid ${C.border};`}padding:${first ? '0' : '12px'} 0 12px ${left ? `${left}px` : '0'}`;
    const photo = thumbs
      ? `<td width="68" ${cell()}">${
          src
            ? `<img src="${esc(src)}" width="56" height="56" alt="" style="display:block;border:1px solid ${C.border};border-radius:8px;background:#fff;object-fit:contain">`
            : `<div class="ed-tint ed-line" style="width:56px;height:56px;border:1px solid ${C.border};border-radius:8px;background:${C.skyTint}"></div>`
        }</td>`
      : '';
    return (
      `<tr valign="top">${photo}<td ${cell()}">` +
      `<div style="font-size:15px;font-weight:600;line-height:21px">${esc(i.name)}</div>` +
      `<div class="ed-m" style="font-size:12px;line-height:18px;color:${C.subtle}">SKU ${esc(i.sku)}</div>` +
      `<b>${i.qty} ×</b> <span class="ed-m" style="color:${C.muted}">${rupees(i.unitPricePaise)}</span>` +
      `</td><td align="right" ${cell(12)};font-size:15px;font-weight:700;line-height:21px;white-space:nowrap">${rupees(i.qty * i.unitPricePaise)}</td></tr>`
    );
  };
  let itemRows = '';
  let rowBytes = 0;
  let shownCount = 0;
  for (const i of o.items) {
    const row = itemRow(i, shownCount === 0);
    rowBytes += Buffer.byteLength(row);
    // always at least one row; then as many as fit
    if (shownCount && rowBytes > ITEM_ROWS_BUDGET) break;
    itemRows += row;
    shownCount++;
  }
  const rest = o.items.slice(shownCount);
  const restUnits = rest.reduce((n, i) => n + i.qty, 0);
  const more = rest.length
    ? `<tr><td colspan="${cols}" class="ed-m ed-line" style="border-top:1px solid ${C.border};padding:12px 0;color:${C.muted}"><b>+${rest.length} more item${rest.length === 1 ? '' : 's'}</b> (${restUnits} unit${restUnits === 1 ? '' : 's'} · ${rupees(rest.reduce((s, i) => s + i.qty * i.unitPricePaise, 0))}) not listed here: see the order in the admin, or this email’s plain-text version.</td></tr>`
    : '';
  const itemsSection = section(
    'Items',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ed-t" style="border-collapse:separate;font-family:${FONT};font-size:14px;line-height:20px;color:${C.text};word-break:break-word">${itemRows}${more}</table>`,
    // each row ends with 12 px of space: 8 more makes the card's usual 20
    { padding: '20px 24px 8px' },
  );

  const codeChip = (c: string) =>
    ` <span style="display:inline-block;background:${C.successSoft};color:${C.success};font-size:12px;font-weight:700;line-height:16px;padding:2px 8px;border-radius:6px;letter-spacing:0.4px">${esc(c)}</span>`;
  const billSection = section(
    'Bill',
    rows(bill.map((l, n) => ({ label: esc(l.label) + (l.code ? codeChip(l.code) : ''), value: esc(l.value), strong: n === bill.length - 1, color: l.good ? C.success : undefined }))) +
      `<div class="ed-m" style="margin-top:6px;font-size:13px;line-height:20px;color:${C.muted}">Payment: ${esc(payment)}</div>`,
  );

  const gstSection = o.gst
    ? section(
        'GST invoice',
        rows(
          [{ label: 'GSTIN', value: esc(o.gst.gstin) }, ...(o.gst.businessName ? [{ label: 'Business', value: esc(o.gst.businessName) }] : [])],
          { valueAlign: 'left', labelWidth: 96 },
        ),
        { padding: '20px 24px 14px' },
      )
    : '';

  const subject = `New order ${o.number} · ${rupees(o.totalPaise)} · ${method}`;
  const html = emailPage({
    title: subject,
    tag: 'Order alert',
    rows: [top, actions, people, notes, itemsSection, billSection, gstSection].filter(Boolean),
    footer: `Sent by ElectroDash to the store team · ${istHtml(o.placedAt)}<br>Replies to this email don’t reach the customer: call them with the buttons above.`,
  });

  return { subject, text, html };
}

/** A Contact us message or a "Request this product" from search, as saved in support_messages. */
export function supportMail(m: {
  userId: number | null;
  name: string;
  email: string;
  phone: string | null;
  topic: string;
  message: string;
  /** when it was sent (now when missing) */
  createdAt?: Date | string | null;
  /** the name on the sender's app account, when they were logged in */
  accountName?: string | null;
}): Alert {
  const topic = TOPIC[m.topic] ?? m.topic;
  const accountName = m.accountName?.replace(/\s+/g, ' ').trim() || '';
  const account = m.userId == null ? 'Not logged in' : accountName || 'Logged in (no name on the account)';
  const fields: [string, string][] = [
    ['Topic', topic],
    ['Name', m.name || '—'],
    ['Phone', m.phone || '—'],
    ['Email', m.email || '—'],
    ['Account', account],
  ];
  const name = m.name.replace(/\s+/g, ' ');
  // the start of the message keeps each one in its own Gmail conversation (same subject = grouped)
  const flat = m.message.replace(/\s+/g, ' ').trim();
  const cut = flat.slice(0, 50);
  const space = cut.lastIndexOf(' ');
  const snippet = flat.length > 50 ? `${(space > 25 ? cut.slice(0, space) : cut).trimEnd()}…` : flat;
  const subject = `Contact us · ${topic}${name ? ` · ${name}` : ''}${snippet ? ` · ${snippet}` : ''}`;
  const text = [...fields.map(([k, v]) => `${k}: ${v}`), '', m.message].join('\n');

  // ---- HTML ----
  const label = m.topic === 'product' && PRODUCT_REQUEST.test(m.message) ? 'Request this product' : topic;
  const [tone, dot] = TOPIC_PILL[m.topic] ?? ['neutral', C.subtle];
  const sent = m.createdAt && !Number.isNaN(new Date(m.createdAt).getTime()) ? new Date(m.createdAt) : new Date();
  const reply = mailtoHref(m.email, `Re: ${label}`);
  const call = telHref(m.phone);
  const whatsapp = waHref(m.phone);
  // an order number written in the message, e.g. "ED-2026-10031"
  const orderNo = m.message.match(/\bED-\d{4}-\d{5,}\b/i)?.[0].toUpperCase();

  const top = banner(
    bannerText.overline('Contact us message') +
      bannerText.title(name.trim() || 'No name given') +
      bannerText.small(ist(sent)) +
      `<div style="margin-top:14px">${pill(label, tone, dot)}</div>`,
  );
  const message = section(
    'Message',
    `<div class="ed-quote" style="background:${C.skyTint};border-left:4px solid ${C.primary};border-radius:4px 12px 12px 4px;padding:16px 18px;font-size:17px;line-height:26px;color:${C.text};word-break:break-word">${lines(m.message)}</div>`,
  );
  const buttons = [
    reply ? button('Reply by email', reply, 'primary') : '',
    call ? button('Call', call, reply ? 'secondary' : 'primary') : '',
    whatsapp ? button('WhatsApp', whatsapp, 'whatsapp') : '',
  ].join('');
  const actions = buttons ? section(null, buttons, { tint: true, padding: '16px 24px 8px' }) : '';
  const details = section(
    'Customer',
    rows(
      [
        { label: 'Name', value: name.trim() ? esc(name.trim()) : muted('Not given') },
        { label: 'Phone', value: m.phone ? phoneLink(m.phone) : muted('Not given') },
        { label: 'Email', value: m.email ? (reply ? link(m.email, `mailto:${m.email.trim()}`) : esc(m.email)) : muted('Not given') },
        { label: 'Account', value: m.userId != null && accountName ? esc(accountName) : muted(account) },
        ...(orderNo ? [{ label: 'Order', value: esc(orderNo) }] : []),
      ],
      { valueAlign: 'left', labelWidth: 96 },
    ),
    { padding: '20px 24px 14px' },
  );

  const html = emailPage({
    title: subject,
    tag: 'Customer message',
    rows: [top, message, actions, details].filter(Boolean),
    footer:
      (m.email ? `Press Reply to answer the customer directly (it goes to ${esc(m.email)}).` : 'No email given: call or WhatsApp the customer to answer.') +
      `<br>Sent by ElectroDash · Contact us · ${istHtml(sent)}`,
  });

  return { subject, text, html, ...(m.email ? { replyTo: m.email } : {}) };
}
