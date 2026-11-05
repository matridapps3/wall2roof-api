import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { orders, products, staffAccounts, staffPushTokens, staffSessions, users } from '../src/db/schema.js';
import { hashPassword, newRefreshToken, signAccessToken } from '../src/lib/auth.js';
import { rupees } from '../src/lib/mailer.js';
import { defaultPushSender, EXPO_PUSH_URL, expoPushSender, type PushMessage, type PushSender, type PushTicket } from '../src/lib/push.js';

let h: DbHandle;
let app: FastifyInstance;
let token: string;
let addressId: number;
let bulbId: number;

/** What the app sent; `fail` makes the sender throw like Expo being down; `answer` is Expo's reply. */
let sent: PushMessage[][] = [];
let attempts = 0;
let fail = false;
let answer: (m: PushMessage[]) => PushTicket[] = (m) => m.map((_, i) => ({ status: 'ok', id: `t${i}` }));
const fake: PushSender = {
  async send(m) {
    attempts++;
    if (fail) throw new Error('Expo is down');
    sent.push(m);
    return answer(m);
  },
};

const pushToken = (n: string) => `ExponentPushToken[${n}]`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, url: string, body?: unknown, auth?: string) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as never, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}
async function order(key: string, qty = 2) {
  await call('PUT', '/v1/cart/items', { productId: bulbId, qty }, token);
  return call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', idempotencyKey: key }, token);
}
/** A staff member with phones; `loggedIn` false = every login has ended (one expired, one logged out). */
async function addStaff(username: string, active: boolean, tokens: string[], loggedIn = true) {
  const [s] = await h.db
    .insert(staffAccounts)
    .values({ username, name: username, passwordHash: await hashPassword('packing-2026'), active })
    .returning();
  const day = 86_400_000;
  const logins = loggedIn
    ? [{ expiresAt: new Date(Date.now() + 90 * day) }]
    : [{ expiresAt: new Date(Date.now() - day) }, { expiresAt: new Date(Date.now() + 90 * day), revokedAt: new Date() }];
  for (const l of logins) await h.db.insert(staffSessions).values({ staffId: s.id, tokenHash: newRefreshToken().hash, ...l });
  for (const t of tokens) await h.db.insert(staffPushTokens).values({ staffId: s.id, token: pushToken(t), platform: 'android' });
  return s;
}
const allTokens = async () => (await h.db.select({ token: staffPushTokens.token }).from(staffPushTokens)).map((t) => t.token).sort();

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { push: fake });
  const [p] = await h.db.insert(products).values({ sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 100 }).returning();
  bulbId = p.id;
  const [u] = await h.db.insert(users).values({ name: 'Priya', phone: '9876500001' }).returning();
  token = await signAccessToken(u.id, 'customer');
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name: 'Ravi', phone: '9876511111', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
    token,
  );
  addressId = a.body.address.id;

  await addStaff('owner', true, ['owner-phone', 'owner-tablet']);
  await addStaff('packer', true, ['packer-phone']);
  await addStaff('left', false, ['left-phone']); // deactivated: no alerts
  await addStaff('no.phone', true, []);
  await addStaff('logged.out', true, ['logged-out-phone'], false); // no live login: no alerts
});

afterEach(() => {
  sent = [];
  attempts = 0;
  fail = false;
  answer = (m) => m.map((_, i) => ({ status: 'ok', id: `t${i}` }));
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('"New order" push to the admin app', () => {
  it('goes to the phones of every active staff member who is logged in, once per order', async () => {
    const o = await order('push-new-1', 2);
    expect(o.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [batch] = sent;
    expect(batch.map((m) => m.to).sort()).toEqual([pushToken('owner-phone'), pushToken('owner-tablet'), pushToken('packer-phone')]);
    for (const m of batch) {
      expect(m).toEqual({
        to: m.to,
        title: `New order ${o.body.number}`,
        body: `${rupees(o.body.totalPaise)} · 2 items · Mohali 140306`,
        data: { type: 'new_order', number: o.body.number },
        sound: 'default',
        priority: 'high',
        channelId: 'orders',
      });
    }
    expect(batch[0].body).toMatch(/^₹[\d,]+(\.\d\d)? · 2 items · Mohali 140306$/);
    await pause(100);
    expect(attempts).toBe(1);
  });

  it('says "1 item" for a single item', async () => {
    const o = await order('push-single-1', 1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0][0].body).toBe(`${rupees(o.body.totalPaise)} · 1 item · Mohali 140306`);
  });

  it('sends nothing again when the app repeats the same order request', async () => {
    const first = await order('push-retry-1', 1);
    expect(first.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const again = await call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', idempotencyKey: 'push-retry-1' }, token);
    expect(again.status).toBe(200);
    expect(again.body.number).toBe(first.body.number);
    await pause(200);
    expect(attempts).toBe(1);
  });

  it('never fails or holds up the order when sending fails', async () => {
    fail = true;
    const o = await order('push-fail-1', 1);
    expect(o.status).toBe(201);
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(await h.db.$count(orders, eq(orders.number, o.body.number))).toBe(1);

    // nor when Expo is slow: the order is answered before the push is out
    fail = false;
    let release!: () => void;
    const slow: PushSender = { send: (m) => new Promise((r) => (release = () => r(m.map(() => ({ status: 'ok' }))))) };
    const slowApp = await buildApp(h.db, {}, { push: slow });
    await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, token);
    const res = await slowApp.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { addressId, paymentMethod: 'cod', idempotencyKey: 'push-slow-1' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await slowApp.close();
  });

  it('forgets a phone whose app was uninstalled (DeviceNotRegistered), and keeps the others', async () => {
    answer = (m) =>
      m.map((msg): PushTicket =>
        msg.to === pushToken('owner-tablet')
          ? { status: 'error', message: '"ExponentPushToken[owner-tablet]" is not a registered push notification recipient', details: { error: 'DeviceNotRegistered' } }
          : msg.to === pushToken('packer-phone')
            ? { status: 'error', message: 'Too many messages', details: { error: 'MessageRateExceeded' } }
            : { status: 'ok', id: 'x' },
      );
    expect((await order('push-gone-1', 1)).status).toBe(201);
    await vi.waitFor(async () => expect(await allTokens()).not.toContain(pushToken('owner-tablet')));
    expect(await allTokens()).toEqual([pushToken('left-phone'), pushToken('logged-out-phone'), pushToken('owner-phone'), pushToken('packer-phone')]);

    // the next order goes to the phones still there
    answer = (m) => m.map(() => ({ status: 'ok' }));
    sent = [];
    await order('push-gone-2', 1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].map((m) => m.to).sort()).toEqual([pushToken('owner-phone'), pushToken('packer-phone')]);
  });

  it('sends nothing when no active staff member has a phone set up', async () => {
    await h.db.delete(staffPushTokens);
    await h.db.insert(staffPushTokens).values({ staffId: (await h.db.select().from(staffAccounts).where(eq(staffAccounts.username, 'left')))[0].id, token: pushToken('left-2'), platform: 'ios' });
    expect((await order('push-none-1', 1)).status).toBe(201);
    await pause(200);
    expect(attempts).toBe(0);
  });
});

describe('Expo push sender', () => {
  const msg = (i: number): PushMessage => ({
    to: pushToken(`p${i}`),
    title: 'New order ED-2026-10001',
    body: '₹500 · 1 item · Mohali 140306',
    data: { type: 'new_order', number: 'ED-2026-10001' },
    sound: 'default',
    priority: 'high',
    channelId: 'orders',
  });
  const okFor = (body: string) => new Response(JSON.stringify({ data: JSON.parse(body).map((_: unknown, i: number) => ({ status: 'ok', id: `id${i}` })) }), { status: 200 });

  it('posts to Expo in batches of 100 and returns a ticket per message, in order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => okFor(String(init?.body)));
    const messages = Array.from({ length: 150 }, (_, i) => msg(i));
    const tickets = await expoPushSender().send(messages);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(EXPO_PUSH_URL).toBe('https://exp.host/--/api/v2/push/send');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual(messages.slice(0, 100));
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual(messages.slice(100));
    expect(tickets).toHaveLength(150);
    expect(tickets.every((t) => t.status === 'ok')).toBe(true);
  });

  it('sends EXPO_ACCESS_TOKEN as a Bearer token when set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => okFor(String(init?.body)));
    await expoPushSender('expo-access-token-123').send([msg(1)]);
    expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer expo-access-token-123');
  });

  it('turns a failed request into error tickets for that batch only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: 'INTERNAL_SERVER_ERROR', message: 'oops' }] }), { status: 500 }));
    fetchSpy.mockImplementationOnce(async (_url, init) => okFor(String(init?.body)));
    const tickets = await expoPushSender().send(Array.from({ length: 101 }, (_, i) => msg(i)));
    expect(tickets).toHaveLength(101);
    expect(tickets.slice(0, 100).every((t) => t.status === 'error' && t.message?.includes('Expo push error (500)'))).toBe(true);
    expect(tickets[100].status).toBe('ok');

    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    expect(await expoPushSender().send([msg(1)])).toEqual([{ status: 'error', message: 'network down' }]);
  });

  it('splits a batch whose phones belong to different Expo projects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errors: [
            {
              code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
              message: 'All push notification messages in the same request must be for the same project; check the details field to investigate conflicting tokens.',
              details: { '@kamaldeepsahu/electrodash-admin': [pushToken('p0'), pushToken('p2')], '@someone/old-project': [pushToken('p1')] },
            },
          ],
        }),
        { status: 400 },
      ),
    );
    fetchSpy.mockImplementation(async (_url, init) => okFor(String(init?.body)));
    const tickets = await expoPushSender().send([msg(0), msg(1), msg(2)]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const sentTo = (n: number) => JSON.parse(String(fetchSpy.mock.calls[n][1]?.body)).map((m: PushMessage) => m.to);
    expect(sentTo(1)).toEqual([pushToken('p0'), pushToken('p2')]);
    expect(sentTo(2)).toEqual([pushToken('p1')]);
    expect(tickets.map((t) => t.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('names only Expo’s error code when it refuses a request, never the push tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ code: 'VALIDATION_ERROR', message: `bad ${pushToken('p9')}`, details: { tokens: [pushToken('p9')] } }] }), { status: 400 }),
    );
    expect(await expoPushSender().send([msg(9)])).toEqual([{ status: 'error', message: 'Expo push error (400) VALIDATION_ERROR' }]);
  });

  it('is off in tests and on (no key needed) on the server', () => {
    expect(defaultPushSender({ isTest: true, EXPO_ACCESS_TOKEN: undefined })).toBeNull();
    expect(defaultPushSender({ isTest: false, EXPO_ACCESS_TOKEN: undefined })).not.toBeNull();
  });
});
