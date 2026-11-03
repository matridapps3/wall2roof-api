import { config } from '../config.js';
import type { AddressFields } from '../db/schema.js';
import { esc } from './html.js';

/**
 * Email alerts to staff: each new order and each Contact us message. Sent through Resend's HTTPS
 * API with a plain fetch (Railway blocks SMTP). RESEND_API_KEY or ALERT_EMAIL_TO unset = no email.
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

/** The live mailer, or null (no email) when the key or the recipients are missing, and in tests. */
export function defaultMailer(c: Pick<typeof config, 'isTest' | 'RESEND_API_KEY' | 'MAIL_FROM' | 'alertEmailTo'> = config): Mailer | null {
  if (c.isTest || !c.RESEND_API_KEY || !c.alertEmailTo.length) return null;
  return resendMailer(c.RESEND_API_KEY, c.MAIL_FROM);
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

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const ist = (at: string) => `${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;

const PAYMENT: Record<string, string> = { cod: 'Cash on delivery', online: 'Online' };
const PAYMENT_STATUS: Record<string, string> = {
  cod_due: 'To collect on delivery',
  pending: 'Not paid yet',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
};
/** As the app's Contact us page names them. */
const TOPIC: Record<string, string> = { order: 'Order issue', payment: 'Payment', delivery: 'Delivery', return: 'Return', product: 'Product', other: 'Other' };

const WRAP = 'font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1A2433';
const H2 = 'font-size:16px;margin:20px 0 6px';
const CELL = 'padding:4px 8px;border-bottom:1px solid #E3E8EF';

/** What the order email needs: the order as the order routes return it, after it is placed. */
export type OrderForMail = {
  number: string;
  placedAt: string;
  totalPaise: number;
  paymentMethod: string;
  paymentStatus: string;
  address: AddressFields;
  deliveryInstructions: string[];
  items: { sku: string; name: string; qty: number; unitPricePaise: number }[];
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
};

export function newOrderMail(o: OrderForMail, customer: { name: string | null; phone: string | null }): Alert {
  const a = o.address;
  const payment = `${PAYMENT[o.paymentMethod] ?? o.paymentMethod} · ${PAYMENT_STATUS[o.paymentStatus] ?? o.paymentStatus}`;
  const who = `${customer.name || 'No name'} · ${customer.phone || 'no phone'}`;
  const receiver = [a.name, a.phone].filter(Boolean).join(' · ');
  const where = [a.line1, a.line2, a.landmark ? `Landmark: ${a.landmark}` : null, `${a.city}, ${a.state} ${a.pincode}`].filter((l): l is string => !!l);
  const map = a.lat != null && a.lng != null ? `https://www.google.com/maps?q=${a.lat},${a.lng}` : null;
  const items = o.items.map((i) => ({ ...i, line: `${i.qty} × ${i.name} (SKU ${i.sku}) · ${rupees(i.unitPricePaise)} each · ${rupees(i.qty * i.unitPricePaise)}` }));
  // the bill as the app's order page shows it
  const b = o.bill;
  const bill: [string, string][] = [['Item total', rupees(b.subtotalPaise)]];
  if (b.handlingFeePaise) bill.push(['Handling charge', `+${rupees(b.handlingFeePaise)}`]);
  bill.push(['Delivery charges', b.deliveryFeePaise ? `+${rupees(b.deliveryFeePaise)}` : 'FREE']);
  if (b.codFeePaise) bill.push(['Cash on delivery fee', `+${rupees(b.codFeePaise)}`]);
  if (b.tipPaise) bill.push(['Delivery partner tip', `+${rupees(b.tipPaise)}`]);
  if (b.discountPaise) bill.push([`Coupon discount${b.couponCode ? ` (${b.couponCode})` : ''}`, `-${rupees(b.discountPaise)}`]);
  bill.push(['Bill total', rupees(b.totalPaise)]);
  const instructions = o.deliveryInstructions.join(', ');
  const gst = o.gst ? `${o.gst.gstin}${o.gst.businessName ? ` · ${o.gst.businessName}` : ''}` : null;

  const text = [
    `New order ${o.number}`,
    `Placed ${ist(o.placedAt)}`,
    '',
    `Customer: ${who}`,
    '',
    'Deliver to',
    receiver,
    ...where,
    ...(map ? [`Map: ${map}`] : []),
    '',
    'Items',
    ...items.map((i) => i.line),
    '',
    'Bill',
    ...bill.map(([k, v]) => `${k}: ${v}`),
    '',
    `Payment: ${payment}`,
    ...(instructions ? [`Delivery instructions: ${instructions}`] : []),
    ...(gst ? [`GSTIN: ${gst}`] : []),
  ].join('\n');

  const html = `<div style="${WRAP}">
<h1 style="font-size:20px;margin:0 0 4px">New order ${esc(o.number)}</h1>
<p style="color:#5B6675;margin:0">Placed ${esc(ist(o.placedAt))}</p>
<p><strong>Customer:</strong> ${esc(who)}</p>
<h2 style="${H2}">Deliver to</h2>
<p style="margin:0">${[receiver, ...where].map(esc).join('<br>')}${map ? `<br><a href="${esc(map)}">Open in Google Maps</a>` : ''}</p>
<h2 style="${H2}">Items</h2>
<table style="border-collapse:collapse">
<tr><th align="left" style="${CELL}">Qty</th><th align="left" style="${CELL}">Item</th><th align="left" style="${CELL}">SKU</th><th align="right" style="${CELL}">Price</th><th align="right" style="${CELL}">Total</th></tr>
${items
  .map(
    (i) =>
      `<tr><td style="${CELL}">${i.qty} ×</td><td style="${CELL}">${esc(i.name)}</td><td style="${CELL}">${esc(i.sku)}</td><td align="right" style="${CELL}">${rupees(i.unitPricePaise)}</td><td align="right" style="${CELL}">${rupees(i.qty * i.unitPricePaise)}</td></tr>`,
  )
  .join('\n')}
</table>
<h2 style="${H2}">Bill</h2>
<table style="border-collapse:collapse">
${bill
  .map(([k, v], n) => {
    const [l, r] = n === bill.length - 1 ? [`<strong>${esc(k)}</strong>`, `<strong>${v}</strong>`] : [esc(k), v];
    return `<tr><td style="${CELL}">${l}</td><td align="right" style="${CELL}">${r}</td></tr>`;
  })
  .join('\n')}
</table>
<p><strong>Payment:</strong> ${esc(payment)}</p>
${instructions ? `<p><strong>Delivery instructions:</strong> ${esc(instructions)}</p>` : ''}
${gst ? `<p><strong>GSTIN:</strong> ${esc(gst)}</p>` : ''}
</div>`;

  return { subject: `New order ${o.number} · ${rupees(o.totalPaise)} · ${PAYMENT[o.paymentMethod] ?? o.paymentMethod}`, text, html };
}

/** A Contact us message or a "Request this product" from search, as saved in support_messages. */
export function supportMail(m: { userId: number | null; name: string; email: string; phone: string | null; topic: string; message: string }): Alert {
  const topic = TOPIC[m.topic] ?? m.topic;
  const rows: [string, string][] = [
    ['Topic', topic],
    ['Name', m.name || '—'],
    ['Phone', m.phone || '—'],
    ['Email', m.email || '—'],
    ['User id', m.userId != null ? String(m.userId) : 'Not logged in'],
  ];
  const name = m.name.replace(/\s+/g, ' ');
  return {
    subject: `Contact us · ${topic}${name ? ` · ${name}` : ''}`,
    text: [...rows.map(([k, v]) => `${k}: ${v}`), '', m.message].join('\n'),
    html: `<div style="${WRAP}">
<h1 style="font-size:20px;margin:0 0 12px">Contact us message</h1>
${rows.map(([k, v]) => `<strong>${esc(k)}:</strong> ${esc(v)}`).join('<br>\n')}
<p style="white-space:pre-wrap;margin:16px 0 0">${esc(m.message)}</p>
</div>`,
    ...(m.email ? { replyTo: m.email } : {}),
  };
}
