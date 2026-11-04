import { eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.ALERT_EMAIL_TO = 'vivek@matridtech.com, orders@example.com';
});

import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { cartItems, products, supportMessages, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/lib/auth.js';
import { defaultMailer, newOrderMail, relayMailer, resendMailer, supportMail, type Mail, type Mailer, type OrderForMail } from '../src/lib/mailer.js';

let h: DbHandle;
let app: FastifyInstance;
let token: string;
let userId: number;
let addressId: number;
let bulbId: number;

/** The emails the app sent; `fail` makes the next sends throw like a provider that's down. */
let sent: Mail[] = [];
let attempts = 0;
let fail = false;
const fake: Mailer = {
  async send(m) {
    attempts++;
    if (fail) throw new Error('Resend is down');
    sent.push(m);
  },
};

async function call(method: string, url: string, body?: unknown, auth?: string, on = app) {
  const res = await on.inject({ method: method as 'GET', url, payload: body as never, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}
const order = (key: string, extra: object = {}, on = app) =>
  call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', idempotencyKey: key, ...extra }, token, on);
const addToCart = (qty: number, on = app) => call('PUT', '/v1/cart/items', { productId: bulbId, qty }, token, on);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { mailer: fake });
  const [p] = await h.db.insert(products).values({ sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 50 }).returning();
  bulbId = p.id;
  const [u] = await h.db.insert(users).values({ name: 'Priya', phone: '9876500001' }).returning();
  userId = u.id;
  token = await signAccessToken(u.id, 'customer');
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name: 'Ravi', phone: '9876511111', line1: '962, Sector 82', landmark: 'Near the gurdwara', city: 'Mohali', state: 'Punjab', pincode: '140306', lat: 30.6942, lng: 76.6909 },
    token,
  );
  addressId = a.body.address.id;
});

afterEach(() => {
  sent = [];
  attempts = 0;
  fail = false;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('new order emails', () => {
  it('emails each new order once to the alert list, and not again for a repeated request', async () => {
    await addToCart(2);
    const o = await order('alert-new-1', { instructions: ['Avoid calling'], gstin: '03ABCDE1234F1Z5', gstBusinessName: 'Matrid Electricals' });
    expect(o.status).toBe(201);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [m] = sent;
    expect(m.to).toEqual(['vivek@matridtech.com', 'orders@example.com']);
    expect(m.subject).toBe(`New order ${o.body.number} · ₹1,015 · Cash on delivery`); // 2 × ₹500 + ₹5 handling + ₹10 COD fee
    expect(m.text).toMatch(/^Placed .+ IST$/m);
    for (const line of [
      'Customer: Priya · 9876500001',
      'Ravi · 9876511111',
      '962, Sector 82',
      'Landmark: Near the gurdwara',
      'Mohali, Punjab 140306',
      'Map: https://www.google.com/maps?q=30.6942,76.6909',
      '2 × 9W LED Bulb (SKU B1) · ₹500 each · ₹1,000',
      'Item total: ₹1,000',
      'Cash on delivery fee: +₹10',
      'Bill total: ₹1,015',
      'Payment: Cash on delivery · To collect on delivery',
      'Delivery instructions: Avoid calling',
      'GSTIN: 03ABCDE1234F1Z5 · Matrid Electricals',
    ]) {
      expect(m.text).toContain(line);
    }
    // the HTML has the same facts, with buttons to call and to open the map
    for (const fact of ['9W LED Bulb', 'SKU B1', '₹1,015', 'Cash on delivery · collect ₹1,015', 'Near the gurdwara', 'Mohali, Punjab 140306', 'Avoid calling', '03ABCDE1234F1Z5', 'Matrid Electricals']) {
      expect(m.html).toContain(fact);
    }
    expect(m.html).toMatch(/<a href="https:\/\/www\.google\.com\/maps\?q=30\.6942,76\.6909"[^>]*>Open in Google Maps<\/a>/);
    expect(m.html).toMatch(/<a href="tel:\+919876500001"[^>]*>Call customer<\/a>/);
    // Ravi gets the parcel: his number too
    expect(m.html).toMatch(/<a href="tel:\+919876511111"[^>]*>Call receiver<\/a>/);
    expect(m.replyTo).toBeUndefined();

    // the app retrying the same order gets the same order back and sends nothing
    const again = await order('alert-new-1');
    expect(again.body.number).toBe(o.body.number);
    await pause(100);
    expect(sent).toHaveLength(1);
  });

  it('a failing email never fails the order', async () => {
    fail = true;
    await addToCart(1);
    const o = await order('alert-fail-1');
    expect(o.status).toBe(201);
    expect(await h.db.$count(cartItems, eq(cartItems.userId, userId))).toBe(0);
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(sent).toHaveLength(0);
  });

  it('customer-entered text is escaped in the HTML', async () => {
    const a = await call(
      'POST',
      '/v1/addresses',
      { label: 'other', name: '<script>alert(1)</script>', phone: '9876511111', line1: '<img src=x onerror=alert(1)>', city: 'Mohali', state: 'Punjab', pincode: '140306' },
      token,
    );
    await addToCart(1);
    const o = await call('POST', '/v1/orders', { addressId: a.body.address.id, paymentMethod: 'cod', idempotencyKey: 'alert-esc-1', instructions: ['"Ring" & wait'] }, token);
    expect(o.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { html, text } = sent[0];
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;Ring&quot; &amp; wait');
    // the plain-text version keeps what was typed
    expect(text).toContain('<script>alert(1)</script> · 9876511111');
  });
});

describe('Contact us emails', () => {
  it('emails a message to the alert list, with Reply going to the customer', async () => {
    const r = await call('POST', '/v1/support', { name: 'Asha', email: 'asha@example.com', phone: '98765 22222', topic: 'delivery', message: 'Where is my order?\nIt is late.' });
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [m] = sent;
    expect(m.to).toEqual(['vivek@matridtech.com', 'orders@example.com']);
    expect(m.subject).toBe('Contact us · Delivery · Asha · Where is my order? It is late.');
    expect(m.replyTo).toBe('asha@example.com');
    expect(m.text).toBe('Topic: Delivery\nName: Asha\nPhone: 98765 22222\nEmail: asha@example.com\nAccount: Not logged in\n\nWhere is my order?\nIt is late.');
    // the message keeps its line breaks; Reply, Call and WhatsApp buttons
    expect(m.html).toContain('Where is my order?<br>It is late.');
    expect(m.html).toMatch(/<a href="mailto:asha@example\.com\?subject=Re%3A%20Delivery"[^>]*>Reply by email<\/a>/);
    expect(m.html).toMatch(/<a href="tel:\+919876522222"[^>]*>Call<\/a>/);
    expect(m.html).toMatch(/<a href="https:\/\/wa\.me\/919876522222"[^>]*>WhatsApp<\/a>/);
    expect(m.html).toContain('Press Reply to answer the customer directly');
  });

  it('a product request from a logged-in customer with no email has no Reply address', async () => {
    const r = await call('POST', '/v1/support', { topic: 'product', message: 'Product request from search: "solar lamp"' }, token);
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [m] = sent;
    expect(m.subject).toBe('Contact us · Product · Product request from search: "solar lamp"');
    expect(m.replyTo).toBeUndefined();
    // the account's name, not its id
    expect(m.text).toContain('Account: Priya');
    expect(m.text).not.toContain('User id');
    expect(m.html).toContain('Product request from search: &quot;solar lamp&quot;');
    expect(m.html).toContain('Request this product');
    expect(m.html).toContain('Priya');
    expect(m.html).not.toContain(`>#${userId}<`);
    // nothing to reply to or call
    expect(m.html).not.toContain('mailto:');
    expect(m.html).not.toContain('tel:');
    expect(m.html).not.toContain('Press Reply');
  });

  it('escapes the name and message in the HTML', async () => {
    await call('POST', '/v1/support', { name: '<script>x()</script>', phone: '9876522222', topic: 'other', message: 'Hi <b>team</b> & co' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { html } = sent[0];
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt;');
    expect(html).toContain('Hi &lt;b&gt;team&lt;/b&gt; &amp; co');
  });

  it('emails at most 20 messages a day from people who aren’t logged in, and keeps them all', async () => {
    await h.db.delete(supportMessages).where(isNull(supportMessages.userId));
    for (let i = 1; i <= 21; i++) {
      expect((await call('POST', '/v1/support', { phone: '1', topic: 'other', message: `hello ${i}` })).status).toBe(201);
    }
    await vi.waitFor(() => expect(sent).toHaveLength(20));
    await pause(100);
    expect(sent).toHaveLength(20);
    expect(await h.db.$count(supportMessages, isNull(supportMessages.userId))).toBe(21);
    // a logged-in customer's message is still emailed
    await call('POST', '/v1/support', { topic: 'order', message: 'Where is my order?' }, token);
    await vi.waitFor(() => expect(sent).toHaveLength(21));
  });
});

describe('how the emails are built', () => {
  const XSS = '<script>alert(1)</script>';
  const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;';
  const sampleOrder = (over: Partial<OrderForMail> = {}): OrderForMail => ({
    number: 'ED-2026-10042',
    placedAt: '2026-11-04T09:42:00.000Z',
    totalPaise: 151_500,
    paymentMethod: 'cod',
    paymentStatus: 'cod_due',
    address: { label: 'home', name: 'Ravi', phone: '9876511111', line1: '962, Sector 82', landmark: 'Near the gurdwara', city: 'Mohali', state: 'Punjab', pincode: '140306', lat: 30.6942, lng: 76.6909 },
    deliveryInstructions: [],
    items: [{ sku: 'B1', name: '9W LED Bulb', qty: 3, unitPricePaise: 50_000, image: 'https://api.example.com/img/a.jpg' }],
    bill: { subtotalPaise: 150_000, deliveryFeePaise: 0, handlingFeePaise: 500, codFeePaise: 1000, discountPaise: 0, couponCode: null, tipPaise: 0, totalPaise: 151_500 },
    gst: null,
    ...over,
  });
  const hrefs = (html: string, scheme: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => h.startsWith(scheme));

  it('keeps the subject lines the staff filter on', () => {
    expect(newOrderMail(sampleOrder(), { name: 'Priya', phone: '9876500001' }).subject).toBe('New order ED-2026-10042 · ₹1,515 · Cash on delivery');
    expect(newOrderMail(sampleOrder({ paymentMethod: 'online', paymentStatus: 'paid' }), { name: null, phone: null }).subject).toBe('New order ED-2026-10042 · ₹1,515 · Online');
    const contact = { userId: null, name: 'Asha  Verma', email: '', phone: '9876522222', topic: 'return', message: 'Wrong size' };
    expect(supportMail(contact).subject).toBe('Contact us · Return · Asha Verma · Wrong size');
    expect(supportMail({ ...contact, name: '' }).subject).toBe('Contact us · Return · Wrong size');
    // a long message is cut at a word within 50 characters, on one line, so each message gets its own Gmail conversation
    expect(supportMail({ ...contact, message: 'The bulb I got\nflickers after ten minutes of use every evening' }).subject).toBe(
      'Contact us · Return · Asha Verma · The bulb I got flickers after ten minutes of use…',
    );
  });

  it('the order email has the order, the people, the items and the bill', () => {
    const { html, text } = newOrderMail(
      sampleOrder({
        deliveryInstructions: ['Avoid calling', 'Pet at home'],
        bill: { subtotalPaise: 150_000, deliveryFeePaise: 3000, handlingFeePaise: 500, codFeePaise: 1000, discountPaise: 5000, couponCode: 'WELCOME50', tipPaise: 2000, totalPaise: 151_500 },
        gst: { gstin: '03ABCDE1234F1Z5', businessName: 'Matrid Electricals' },
      }),
      { name: 'Priya', phone: '9876500001' },
    );
    for (const fact of [
      'ED-2026-10042',
      '4 Nov 2026, 3:12 pm IST',
      'Cash on delivery · collect ₹1,515',
      '3 items',
      'Priya',
      'Ravi',
      '98765 00001',
      '98765 11111',
      '962, Sector 82',
      'Near the gurdwara',
      'Mohali, Punjab 140306',
      '9W LED Bulb',
      'SKU B1',
      '₹500',
      '₹1,500',
      'Item total',
      'Handling charge',
      '+₹30',
      'Cash on delivery fee',
      'Delivery partner tip',
      'WELCOME50',
      '-₹50',
      'Bill total',
      'Avoid calling',
      'Pet at home',
      '03ABCDE1234F1Z5',
      'Matrid Electricals',
    ]) {
      expect(html).toContain(fact);
    }
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<img src="https://api.example.com/img/a.jpg"');
    // cash still to collect is not shown in the green of "Paid"
    const payPill = (h: string) => h.match(/<span[^>]*background:(#[0-9A-F]{6})[^>]*>(?:<span[^>]*>&#9679;<\/span>&nbsp;)?(?:Cash on delivery|Online) · [^<]*<\/span>/)?.[1];
    expect(payPill(html)).toBe('#FDF6E7');
    expect(payPill(newOrderMail(sampleOrder({ paymentMethod: 'online', paymentStatus: 'paid' }), { name: null, phone: null }).html)).toBe('#E7F5EF');
    // the time in the footer doesn't break ("IST" alone on a line)
    expect(html).toContain('<span style="white-space:nowrap">4 Nov 2026, 3:12 pm IST</span>');
    expect(text).toContain('Coupon discount (WELCOME50): -₹50');
    expect(text).toContain('Delivery instructions: Avoid calling, Pet at home');
  });

  it('escapes every customer-entered and product string in the order email', () => {
    const { html, text } = newOrderMail(
      sampleOrder({
        address: { label: 'home', name: XSS, phone: '9876511111', line1: `<img src=x onerror=alert(1)>`, line2: XSS, landmark: XSS, city: XSS, state: 'Punjab', pincode: '140306' },
        deliveryInstructions: [XSS],
        items: [{ sku: XSS, name: XSS, qty: 1, unitPricePaise: 50_000, image: null }],
        bill: { subtotalPaise: 50_000, deliveryFeePaise: 0, handlingFeePaise: 0, codFeePaise: 0, discountPaise: 100, couponCode: XSS, tipPaise: 0, totalPaise: 49_900 },
        gst: { gstin: XSS, businessName: XSS },
        number: XSS,
      }),
      { name: XSS, phone: XSS },
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // name, receiver, address lines, landmark, city, instruction, product name, SKU, coupon, GSTIN, business, order number, phone as typed
    expect(html.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(13);
    // a "phone" that isn't one is shown, not dialled: only the receiver's (button and number) rings
    expect(hrefs(html, 'tel:')).toEqual(['tel:+919876511111', 'tel:+919876511111']);
    expect(text).toContain(`Customer: ${XSS} · ${XSS}`);
  });

  it('call buttons only for real phone numbers, and Call receiver only when it is another phone', () => {
    const same = newOrderMail(sampleOrder({ address: { ...sampleOrder().address, phone: '+91 98765 00001' } }), { name: 'Priya', phone: '9876500001' }).html;
    expect(same).toContain('Call customer');
    expect(same).not.toContain('Call receiver');
    expect(hrefs(same, 'tel:')).toEqual(['tel:+919876500001', 'tel:+919876500001', 'tel:+919876500001']);

    const noPhone = newOrderMail(sampleOrder(), { name: 'Priya', phone: null }).html;
    expect(noPhone).not.toContain('Call customer');
    expect(noPhone).toMatch(/<a href="tel:\+919876511111"[^>]*>Call receiver<\/a>/);

    for (const html of [same, noPhone]) {
      for (const h of hrefs(html, 'tel:')) expect(h).toMatch(/^tel:\+?\d+$/);
      expect(html).not.toMatch(/javascript:/i);
    }
  });

  it('no pin on the map: the button searches the address instead', () => {
    const a = { ...sampleOrder().address, lat: null, lng: null };
    const { html, text } = newOrderMail(sampleOrder({ address: a }), { name: 'Priya', phone: '9876500001' });
    const search = 'https://www.google.com/maps/search/?api=1&amp;query=962%2C%20Sector%2082%2C%20Near%20the%20gurdwara%2C%20Mohali%2C%20Punjab%20140306';
    expect(html).toContain(`<a href="${search}"`);
    expect(html).not.toContain('maps?q=');
    expect(text).toContain('Map: https://www.google.com/maps/search/?api=1&query=962%2C%20Sector%2082');
    // anything but numbers in lat/lng is not put in the link
    const odd = newOrderMail(sampleOrder({ address: { ...a, lat: '1"><script>' as never, lng: 2 } }), { name: null, phone: null }).html;
    expect(odd).not.toContain('maps?q=');
    expect(odd).not.toMatch(/<script/i);
  });

  it('product photos only from https:// addresses', () => {
    const items = [
      { sku: 'A', name: 'Good', qty: 1, unitPricePaise: 100, image: 'https://api.example.com/img/a.jpg?w=1&x="y"' },
      { sku: 'B', name: 'Missing', qty: 1, unitPricePaise: 100, image: null },
      { sku: 'C', name: 'Plain http', qty: 1, unitPricePaise: 100, image: 'http://api.example.com/img/c.jpg' },
      { sku: 'D', name: 'Script', qty: 1, unitPricePaise: 100, image: 'javascript:alert(1)' },
      { sku: 'E', name: 'Data', qty: 1, unitPricePaise: 100, image: 'data:image/png;base64,AAAA' },
      { sku: 'F', name: 'Relative', qty: 1, unitPricePaise: 100, image: '/img/f.jpg' },
      { sku: 'G', name: 'Broken', qty: 1, unitPricePaise: 100, image: 'https://' },
    ];
    const { html } = newOrderMail(sampleOrder({ items }), { name: null, phone: null });
    const imgs = [...html.matchAll(/<img [^>]*src="([^"]*)"/g)].map((m) => m[1]);
    expect(imgs).toEqual(['https://api.example.com/img/a.jpg?w=1&amp;x=%22y%22']);
    expect(html).not.toMatch(/javascript:|data:image|http:\/\/api/i);
    // an item without a photo gets an empty tile that dark mode darkens too
    expect(html.match(/<div class="ed-tint ed-line" style="width:56px/g)).toHaveLength(6);
    // without any photo there is no photo column at all
    expect(newOrderMail(sampleOrder({ items: items.slice(1, 2) }), { name: null, phone: null }).html).not.toContain('<img');
  });

  it('photos stored on the server load as the small 160 px version', () => {
    const own = `https://wall2roof-api-production.up.railway.app/img/${'0a'.repeat(16)}.png`;
    const items = [
      { sku: 'A', name: 'Own', qty: 1, unitPricePaise: 100, image: own },
      { sku: 'B', name: 'Own, already sized', qty: 1, unitPricePaise: 100, image: `${own}?w=640` },
      { sku: 'C', name: 'Elsewhere', qty: 1, unitPricePaise: 100, image: 'https://cdn.example.com/photos/c.jpg' },
    ];
    const { html } = newOrderMail(sampleOrder({ items }), { name: null, phone: null });
    expect([...html.matchAll(/<img [^>]*src="([^"]*)"/g)].map((m) => m[1])).toEqual([`${own}?w=160`, `${own}?w=640`, 'https://cdn.example.com/photos/c.jpg']);
  });

  it('the voice note is a link only when the server has a public https address', () => {
    const was = config.publicUrl;
    try {
      config.publicUrl = 'https://api.example.com';
      const on = newOrderMail(sampleOrder({ voiceNote: '/voice/12/abc.m4a' }), { name: null, phone: null });
      expect(on.html).toMatch(/<a href="https:\/\/api\.example\.com\/voice\/12\/abc\.m4a"[^>]*>Play voice note<\/a>/);
      expect(on.text).toContain('Voice note: https://api.example.com/voice/12/abc.m4a');
      config.publicUrl = 'http://localhost:4000';
      const off = newOrderMail(sampleOrder({ voiceNote: '/voice/12/abc.m4a' }), { name: null, phone: null });
      expect(off.html).not.toContain('/voice/12');
      expect(off.html).toContain('Voice note recorded');
      expect(off.text).toContain('Voice note: recorded');
      expect(newOrderMail(sampleOrder(), { name: null, phone: null }).html).not.toMatch(/voice note/i);
    } finally {
      config.publicUrl = was;
    }
  });

  it('stays well under the relay’s 200 KB (and Gmail’s ~100 KB clipping) with 30 items', () => {
    const items = Array.from({ length: 30 }, (_, n) => ({
      sku: `SKU-${100000 + n}`,
      name: `Philips Stellar Bright LED T-Beamer - 20W / Cool White / B22 929003777101 & more text ${n}`,
      qty: (n % 4) + 1,
      unitPricePaise: 51_700 + n,
      image: `https://wall2roof-api-production.up.railway.app/img/${'f'.repeat(32)}.png`,
    }));
    const { html, text } = newOrderMail(
      sampleOrder({ items, deliveryInstructions: ['Avoid calling', 'Leave with the guard'], gst: { gstin: '03ABCDE1234F1Z5', businessName: 'Matrid Electricals' }, voiceNote: '/voice/1/a.m4a' }),
      { name: 'Priya Sharma', phone: '9876500001' },
    );
    expect(Buffer.byteLength(html)).toBeLessThan(100 * 1024);
    expect(Buffer.byteLength(text)).toBeLessThan(200 * 1024);
    expect(html.match(/<img /g)).toHaveLength(30);
    expect(html).not.toContain('more item');
  });

  it('a very long order still fits before Gmail clips it: the bill is never cut off', () => {
    const order = (count: number, nameLength: number) => {
      const items = Array.from({ length: count }, (_, n) => ({
        sku: `SKU-${100000 + n}`,
        name: `${n + 1}. ${'Philips Stellar Bright LED T-Beamer & Downlight '.repeat(5)}`.slice(0, nameLength),
        qty: 2,
        unitPricePaise: 10_000,
        image: `https://wall2roof-api-production.up.railway.app/img/${'f'.repeat(32)}.png`,
      }));
      return newOrderMail(
        sampleOrder({
          items,
          address: { label: 'home', name: 'R'.repeat(80), phone: '9876511111', line1: 'L'.repeat(200), line2: 'M'.repeat(200), landmark: 'N'.repeat(120), city: 'Mohali', state: 'Punjab', pincode: '140306', lat: 30.69, lng: 76.69 },
          deliveryInstructions: Array.from({ length: 5 }, () => '&'.repeat(60)),
          gst: { gstin: '03ABCDE1234F1Z5', businessName: '&'.repeat(120) },
          voiceNote: '/voice/1/a.m4a',
        }),
        { name: 'P'.repeat(80), phone: '9876500001' },
      );
    };
    // 60 lines: all listed
    const sixty = order(60, 90);
    expect(sixty.html.match(/<img /g)).toHaveLength(60);
    expect(sixty.html).not.toContain('more item');
    expect(Buffer.byteLength(sixty.html)).toBeLessThan(90 * 1024);

    for (const [count, nameLength] of [[100, 90], [100, 240], [400, 90]]) {
      const { html, text } = order(count, nameLength);
      expect(Buffer.byteLength(html)).toBeLessThan(90 * 1024);
      const shown = html.match(/<img /g)?.length ?? 0;
      expect(shown).toBeGreaterThanOrEqual(55);
      // the ones not listed are counted (2 units, ₹200 each line), and the bill, GST and footer are all there
      const rest = count - shown;
      expect(html).toContain(`+${rest} more items</b> (${rest * 2} units · ₹${(rest * 200).toLocaleString('en-IN')})`);
      expect(html.indexOf('Bill total')).toBeGreaterThan(html.indexOf('more items'));
      expect(html).toContain('03ABCDE1234F1Z5');
      expect(html).toContain('Sent by ElectroDash');
      // the plain-text version lists every line
      expect(text.match(/^2 × /gm)).toHaveLength(count);
    }
  });

  it('escapes the Contact us name, message and topic, and keeps the line breaks', () => {
    const { html, text } = supportMail({ userId: 7, name: XSS, email: '', phone: null, topic: XSS, message: `Line one\n${XSS}\r\nLine & three` });
    expect(html).not.toMatch(/<script/i);
    expect(html.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(3); // name, topic pill, message
    expect(html).toContain(`Line one<br>${ESCAPED}<br>Line &amp; three`);
    expect(text).toBe(`Topic: ${XSS}\nName: ${XSS}\nPhone: —\nEmail: —\nAccount: Logged in (no name on the account)\n\nLine one\n${XSS}\r\nLine & three`);
  });

  it('Reply, Call and WhatsApp buttons only for a valid email and phone', () => {
    const base = { userId: null, name: 'Asha', topic: 'payment', message: 'Charged twice for ED-2026-10031, please check' };
    const full = supportMail({ ...base, email: 'asha@example.com', phone: '+91 98765 22222' });
    expect(hrefs(full.html, 'mailto:')).toContain('mailto:asha@example.com?subject=Re%3A%20Payment');
    expect(full.html).toMatch(/<a href="tel:\+919876522222"[^>]*>Call<\/a>/);
    expect(full.html).toMatch(/<a href="https:\/\/wa\.me\/919876522222"[^>]*>WhatsApp<\/a>/);
    expect(full.html).toContain('Press Reply to answer the customer directly');
    expect(full.html).toContain('ED-2026-10031'); // the order number in the message, on the details card
    expect(full.replyTo).toBe('asha@example.com');

    // a foreign number can be called but not WhatsApped from here; a made-up email gets no mailto:
    const foreign = supportMail({ ...base, email: 'asha@example.com?bcc=all@example.com', phone: '+1 415 555 0100' });
    expect(hrefs(foreign.html, 'tel:')).toEqual(['tel:+14155550100', 'tel:+14155550100']);
    expect(foreign.html).not.toContain('wa.me');
    expect(foreign.html).not.toContain('mailto:');
    expect(foreign.html).toContain('asha@example.com?bcc=all@example.com');

    // "1" or words are not phone numbers; no email = no Reply hint
    for (const phone of ['1', 'call me', `javascript:alert(1)`]) {
      const none = supportMail({ ...base, email: '', phone });
      expect(none.html).not.toContain('tel:');
      expect(none.html).not.toContain('wa.me');
      expect(none.html).not.toContain('mailto:');
      expect(none.html).not.toContain('Press Reply');
      expect(none.html).not.toMatch(/href="javascript:/i);
      expect(none.replyTo).toBeUndefined();
    }
  });
});

describe('Resend', () => {
  const mail: Mail = { to: ['vivek@matridtech.com'], subject: 'New order', text: 'Plain', html: '<p>Rich</p>' };

  it('posts the email to Resend’s API with the key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"e1"}', { status: 200 }));
    await resendMailer('re_test_123', 'ElectroDash <onboarding@resend.dev>').send({ ...mail, replyTo: 'asha@example.com' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer re_test_123', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'ElectroDash <onboarding@resend.dev>',
      to: ['vivek@matridtech.com'],
      subject: 'New order',
      text: 'Plain',
      html: '<p>Rich</p>',
      reply_to: 'asha@example.com',
    });
  });

  it('fails when Resend refuses the email', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('{"message":"You can only send testing emails to your own email address"}', { status: 403 }));
    await expect(resendMailer('re_test_123', 'ElectroDash <onboarding@resend.dev>').send(mail)).rejects.toThrow('Resend error (403)');
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(resendMailer('re_test_123', 'ElectroDash <onboarding@resend.dev>').send(mail)).rejects.toThrow('Resend error (500)');
    // no reply_to when there's no customer email
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).not.toHaveProperty('reply_to');
  });

  it('there is no mailer without RESEND_API_KEY or recipients, and none in tests', async () => {
    expect(config.alertEmailTo).toEqual(['vivek@matridtech.com', 'orders@example.com']);
    expect(defaultMailer()).toBeNull();
    const live = { ...config, isTest: false, MAIL_RELAY_URL: undefined, MAIL_RELAY_KEY: undefined };
    expect(defaultMailer({ ...live, RESEND_API_KEY: undefined })).toBeNull();
    expect(defaultMailer({ ...live, RESEND_API_KEY: 're_test_123', alertEmailTo: [] })).toBeNull();
    expect(defaultMailer({ ...live, RESEND_API_KEY: 're_test_123' })).not.toBeNull();

    // an app built the normal way sends nothing anywhere
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no outside calls'));
    const plain = await buildApp(h.db);
    try {
      await addToCart(1, plain);
      expect((await order('alert-plain-1', {}, plain)).status).toBe(201);
      expect((await call('POST', '/v1/support', { topic: 'other', message: 'Just saying hello' }, token, plain)).status).toBe(201);
      await pause(100);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(attempts).toBe(0);
    } finally {
      await plain.close();
    }
  });
});

describe('Mail relay (the Wall2Roof app on Cloudways)', () => {
  const RELAY_URL = 'https://wall2roof.example.com/api/electrodash/mail';
  const RELAY_KEY = 'relay-test-key-0123456789abcdef0123';
  const mail: Mail = { to: ['vivek@matridtech.com', 'orders@example.com'], subject: 'New order', text: 'Plain', html: '<p>Rich</p>' };
  const accepted = () => new Response('{"ok":true}', { status: 202, headers: { 'Content-Type': 'application/json' } });
  const bodyOf = (spy: { mock: { calls: unknown[][] } }, n = 0) => JSON.parse(String((spy.mock.calls[n][1] as RequestInit).body));

  it('posts the email as JSON with the Bearer key, replyTo null when there is none', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    await relayMailer(RELAY_URL, RELAY_KEY).send(mail);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(RELAY_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${RELAY_KEY}`, 'Content-Type': 'application/json' });
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(bodyOf(fetchSpy)).toEqual({ to: ['vivek@matridtech.com', 'orders@example.com'], subject: 'New order', text: 'Plain', html: '<p>Rich</p>', replyTo: null });

    await relayMailer(RELAY_URL, RELAY_KEY).send({ ...mail, replyTo: 'asha@example.com' });
    expect(bodyOf(fetchSpy, 1).replyTo).toBe('asha@example.com');
  });

  it('carries the app’s alerts: Reply to the customer for Contact us, none for an order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    const relayed = await buildApp(h.db, {}, { mailer: relayMailer(RELAY_URL, RELAY_KEY) });
    try {
      const r = await call('POST', '/v1/support', { email: 'asha@example.com', topic: 'delivery', message: 'Where is my order?' }, token, relayed);
      expect(r.status).toBe(201);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(String(fetchSpy.mock.calls[0][0])).toBe(RELAY_URL);
      expect(bodyOf(fetchSpy)).toMatchObject({ to: ['vivek@matridtech.com', 'orders@example.com'], subject: 'Contact us · Delivery · Where is my order?', replyTo: 'asha@example.com' });
      expect(bodyOf(fetchSpy).text).toContain('Where is my order?');
      expect(bodyOf(fetchSpy).html).toContain('Where is my order?');

      await addToCart(1, relayed);
      const o = await order('relay-ok-1', {}, relayed);
      expect(o.status).toBe(201);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      expect(String(fetchSpy.mock.calls[1][0])).toBe(RELAY_URL);
      expect(bodyOf(fetchSpy, 1)).toMatchObject({ subject: `New order ${o.body.number} · ₹515 · Cash on delivery`, replyTo: null });
      expect(bodyOf(fetchSpy, 1).text).toContain('1 × 9W LED Bulb (SKU B1)');
    } finally {
      await relayed.close();
    }
  });

  it('fails on anything but 2xx, and the error never has the key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const relay = relayMailer(RELAY_URL, RELAY_KEY);
    const answers: [number, string][] = [
      [401, '{"error":"Wrong or missing key"}'],
      [422, '{"error":"to: not an allowed recipient"}'],
      [503, '{"error":"Mail relay is not set up"}'],
      [502, '{"error":"The mail server refused the email"}'],
    ];
    for (const [status, body] of answers) {
      fetchSpy.mockResolvedValueOnce(new Response(body, { status }));
      const err = await relay.send(mail).then(() => null, (e: Error) => e);
      expect(err?.message).toBe(`Mail relay error (${status}) ${body}`);
      expect(`${err?.message} ${err?.stack}`).not.toContain(RELAY_KEY);
    }
    // a redirect (say, to a login page) is not a sent email
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://wall2roof.example.com/login' } }));
    await expect(relay.send(mail)).rejects.toThrow('Mail relay error (302)');
    // a long answer is cut to 300 characters
    fetchSpy.mockResolvedValueOnce(new Response('x'.repeat(1000), { status: 500 }));
    await expect(relay.send(mail)).rejects.toThrow(new Error(`Mail relay error (500) ${'x'.repeat(300)}`));
    // even an answer that repeats the key
    fetchSpy.mockResolvedValueOnce(new Response(`Bad header: Bearer ${RELAY_KEY}`, { status: 400 }));
    const echoed = await relay.send(mail).then(() => null, (e: Error) => e);
    expect(echoed?.message).toBe('Mail relay error (400) Bad header: Bearer [key]');
  });

  it('a key pasted with a line break in it never gets into the error either', async () => {
    // Node's own fetch refuses such a header before sending anything, and quotes the header in its
    // message (port 1 is one fetch never connects to, in case it ever did send)
    for (const key of [`${RELAY_KEY}\nsecond-line`, `${RELAY_KEY}\nsecond-line\n`, `${RELAY_KEY}\u0000x`]) {
      const err = await relayMailer('https://127.0.0.1:1/api/electrodash/mail', key)
        .send(mail)
        .then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/^Mail relay unreachable: /);
      expect(err?.cause).toBeUndefined();
      expect(`${err?.message} ${err?.stack}`).not.toContain(RELAY_KEY);
      expect(`${err?.message} ${err?.stack}`).not.toContain('second-line');
    }
    // a relay that can't be reached says why
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND wall2roof.example.com') }));
    await expect(relayMailer(RELAY_URL, RELAY_KEY).send(mail)).rejects.toThrow(
      new Error('Mail relay unreachable: fetch failed (getaddrinfo ENOTFOUND wall2roof.example.com)'),
    );
  });

  it('picks the mailer: Resend first, else the relay (https only), else none', async () => {
    const live = { ...config, isTest: false, RESEND_API_KEY: undefined, MAIL_RELAY_URL: undefined, MAIL_RELAY_KEY: undefined };
    const relayVars = { MAIL_RELAY_URL: RELAY_URL, MAIL_RELAY_KEY: RELAY_KEY };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    const sendsTo = async (m: Mailer | null) => {
      expect(m).not.toBeNull();
      await m!.send(mail);
      return String(fetchSpy.mock.lastCall![0]);
    };

    expect(await sendsTo(defaultMailer({ ...live, RESEND_API_KEY: 're_test_123', ...relayVars }))).toBe('https://api.resend.com/emails');
    expect(await sendsTo(defaultMailer({ ...live, ...relayVars }))).toBe(RELAY_URL);
    expect(defaultMailer({ ...live, ...relayVars, MAIL_RELAY_URL: 'http://wall2roof.example.com/api/electrodash/mail' })).toBeNull();
    // a typo turns email off (the server still starts), and stray spaces are forgiven
    expect(defaultMailer({ ...live, ...relayVars, MAIL_RELAY_URL: 'wall2roof.example.com/api/electrodash/mail' })).toBeNull();
    expect(defaultMailer({ ...live, ...relayVars, MAIL_RELAY_URL: ` ${RELAY_URL}\n` })).not.toBeNull();
    expect(defaultMailer({ ...live, MAIL_RELAY_URL: RELAY_URL })).toBeNull();
    expect(defaultMailer({ ...live, MAIL_RELAY_KEY: RELAY_KEY })).toBeNull();
    expect(defaultMailer(live)).toBeNull();
    expect(defaultMailer({ ...live, ...relayVars, alertEmailTo: [] })).toBeNull();
    expect(defaultMailer({ ...live, ...relayVars, isTest: true })).toBeNull();
  });

  it('an order is still placed when the relay fails or can’t be reached, and the log has no key', async () => {
    const logs: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"error":"The mail server refused the email"}', { status: 502 }));
    const relayed = await buildApp(
      h.db,
      { logger: { level: 'error', stream: { write: (line: string) => void logs.push(line) } } },
      { mailer: relayMailer(RELAY_URL, RELAY_KEY) },
    );
    try {
      await addToCart(1, relayed);
      const o = await order('relay-fail-1', {}, relayed);
      expect(o.status).toBe(201);
      expect(await h.db.$count(cartItems, eq(cartItems.userId, userId))).toBe(0);
      await vi.waitFor(() => expect(logs.join('')).toContain('order email failed'));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(logs.join('')).toContain('Mail relay error (502)');

      // a relay that can't be reached at all doesn't fail the order either
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      await addToCart(1, relayed);
      expect((await order('relay-down-1', {}, relayed)).status).toBe(201);
      await vi.waitFor(() => expect(logs.filter((l) => l.includes('order email failed'))).toHaveLength(2));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(logs.join('')).not.toContain(RELAY_KEY);
    } finally {
      await relayed.close();
    }
  });

  it('a relay that doesn’t answer holds up neither an order nor a Contact us message', async () => {
    // the relay answers only when the test says so: a request that waited for its email would never return
    const waiting: ((r: Response) => void)[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => void waiting.push(r)));
    const relayed = await buildApp(h.db, {}, { mailer: relayMailer(RELAY_URL, RELAY_KEY) });
    try {
      await addToCart(1, relayed);
      expect((await order('relay-slow-1', {}, relayed)).status).toBe(201);
      expect((await call('POST', '/v1/support', { topic: 'other', message: 'Just saying hello' }, token, relayed)).status).toBe(201);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    } finally {
      waiting.forEach((answer) => answer(accepted()));
      await relayed.close();
    }
  });
});
