import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { products, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/lib/auth.js';
import { VoiceStore } from '../src/lib/voice.js';

let h: DbHandle;
let app: FastifyInstance;
let dir: string;
let token: string;
let otherToken: string;
let userId: number;
let addressId: number;
let bulbId: number;

async function call(method: string, url: string, body?: unknown, auth?: string, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as never,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.headers['content-type']?.toString().includes('json') ? (res.json() as any) : res.rawPayload };
}

/** A tiny but real-looking .m4a: size, "ftyp", brand. */
const m4a = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(200, 1)]);

const order = (key: string, extra: object = {}) => call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', idempotencyKey: key, ...extra }, token);

beforeAll(async () => {
  h = await openDb({ memory: true });
  dir = await mkdtemp(join(tmpdir(), 'ed-voice-'));
  app = await buildApp(h.db, {}, { voice: new VoiceStore(dir) });
  const [p] = await h.db.insert(products).values({ sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 50 }).returning();
  bulbId = p.id;
  const [u, v] = await h.db
    .insert(users)
    .values([
      { name: 'Priya', phone: '9876500001' },
      { name: 'Other', phone: '9876500002' },
    ])
    .returning();
  userId = u.id;
  token = await signAccessToken(u.id, 'customer');
  otherToken = await signAccessToken(v.id, 'customer');
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name: 'Priya', phone: '9876500001', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
    token,
  );
  addressId = a.body.address.id;
});

afterAll(async () => {
  await app.close();
  await h.close();
  await rm(dir, { recursive: true, force: true });
});

describe('checkout extras', () => {
  it('a tip is added to the quote and capped at ₹500', async () => {
    const q = await call('POST', '/v1/cart/quote', { items: [{ productId: bulbId, qty: 1 }], tipPaise: 3000 });
    expect(q.body).toMatchObject({ subtotalPaise: 50_000, tipPaise: 3000 });
    expect(q.body.totalPaise).toBe(50_000 + 500 + 3000); // + handling, delivery is free
    expect((await call('POST', '/v1/cart/quote', { items: [{ productId: bulbId, qty: 1 }], tipPaise: 50_001 })).status).toBe(400);
    // an empty cart has no tip
    expect((await call('POST', '/v1/cart/quote', { items: [], tipPaise: 2000 })).body).toMatchObject({ tipPaise: 0, totalPaise: 0 });
  });

  it('saves the tip, GSTIN and receiver on the order', async () => {
    await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, token);
    const o = await order('extras-1', {
      tipPaise: 2000,
      gstin: ' 03abcde1234f1z5 ',
      gstBusinessName: 'Matrid Electricals',
      receiver: { name: 'Ravi', phone: '+91 98765 11111' },
    });
    expect(o.status).toBe(201);
    expect(o.body.bill).toMatchObject({ tipPaise: 2000, totalPaise: 50_000 + 500 + 1000 + 2000 }); // handling + COD + tip
    expect(o.body.gst).toEqual({ gstin: '03ABCDE1234F1Z5', businessName: 'Matrid Electricals' });
    // the receiver goes on this order; the saved address keeps its own name and number
    expect(o.body.address).toMatchObject({ name: 'Ravi', phone: '9876511111', line1: '962, Sector 82' });
    const saved = (await call('GET', '/v1/addresses', undefined, token)).body.addresses[0];
    expect(saved).toMatchObject({ name: 'Priya', phone: '9876500001' });
    expect(o.body.voiceNote).toBeNull();
  });

  it('rejects a bad GSTIN, a GSTIN without a business name, and a bad receiver number', async () => {
    await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, token);
    const bad1 = await order('bad-gstin-1', { gstin: '12345' });
    expect([bad1.status, bad1.body.error.message]).toEqual([400, expect.stringContaining('valid 15-character GSTIN')]);
    const bad2 = await order('bad-gstin-2', { gstin: '03ABCDE1234F1Z5' });
    expect([bad2.status, bad2.body.error.code]).toEqual([400, 'invalid_gstin']);
    const bad3 = await order('bad-receiver-1', { receiver: { name: 'Ravi', phone: '12345' } });
    expect([bad3.status, bad3.body.error.code]).toEqual([400, 'invalid_receiver']);
  });

  it('a voice instruction is uploaded, attached to the order and can be played', async () => {
    // only logged-in customers, only audio that looks like a recording
    expect((await call('POST', '/v1/voice-notes', m4a, undefined, { 'content-type': 'audio/mp4' })).status).toBe(401);
    expect((await call('POST', '/v1/voice-notes', Buffer.from('not audio at all'), token, { 'content-type': 'audio/mp4' })).status).toBe(400);

    const up = await call('POST', '/v1/voice-notes', m4a, token, { 'content-type': 'audio/mp4' });
    expect(up.status).toBe(201);
    expect(up.body.id).toMatch(/^[a-f0-9]{32}$/);

    // someone else can't attach it to their order
    const theirAddress = await call('POST', '/v1/addresses', { label: 'home', name: 'Other', phone: '9876500002', line1: '1, Phase 7', city: 'Mohali', state: 'Punjab', pincode: '140306' }, otherToken);
    await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, otherToken);
    const theirs = await call('POST', '/v1/orders', { addressId: theirAddress.body.address.id, paymentMethod: 'cod', idempotencyKey: 'voice-other-1', voiceNoteId: up.body.id }, otherToken);
    expect([theirs.status, theirs.body.error.code]).toEqual([400, 'invalid_voice_note']);

    await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, token);
    const o = await order('voice-mine-1', { voiceNoteId: up.body.id });
    expect(o.status).toBe(201);
    expect(o.body.voiceNote).toBe(`/voice/${userId}/${up.body.id}.m4a`);

    const play = await app.inject({ method: 'GET', url: o.body.voiceNote });
    expect(play.statusCode).toBe(200);
    expect(play.headers['content-type']).toBe('audio/mp4');
    expect(play.rawPayload.equals(m4a)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/voice/${userId}/${'0'.repeat(32)}.m4a` })).statusCode).toBe(404);
  });
});
