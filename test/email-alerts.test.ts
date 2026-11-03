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
import { defaultMailer, resendMailer, type Mail, type Mailer } from '../src/lib/mailer.js';

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
    expect(m.html).toContain('>9W LED Bulb</td>');
    expect(m.html).toContain('<a href="https://www.google.com/maps?q=30.6942,76.6909">Open in Google Maps</a>');
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
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; · 9876511111');
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
    expect(m.subject).toBe('Contact us · Delivery · Asha');
    expect(m.replyTo).toBe('asha@example.com');
    expect(m.text).toBe('Topic: Delivery\nName: Asha\nPhone: 98765 22222\nEmail: asha@example.com\nUser id: Not logged in\n\nWhere is my order?\nIt is late.');
    expect(m.html).toContain('Where is my order?\nIt is late.');
  });

  it('a product request from a logged-in customer with no email has no Reply address', async () => {
    const r = await call('POST', '/v1/support', { topic: 'product', message: 'Product request from search: "solar lamp"' }, token);
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [m] = sent;
    expect(m.subject).toBe('Contact us · Product');
    expect(m.replyTo).toBeUndefined();
    expect(m.text).toContain(`User id: ${userId}`);
    expect(m.html).toContain('Product request from search: &quot;solar lamp&quot;');
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
    const live = { ...config, isTest: false };
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
