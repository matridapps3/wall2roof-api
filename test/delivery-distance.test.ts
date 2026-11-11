import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { products, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/lib/auth.js';
import { setDistanceLookup } from '../src/lib/checkout.js';
import { deliveryPricing, distanceFeePaise, googleDistanceLookup, type DistanceLookup } from '../src/lib/delivery-distance.js';
import { DEFAULT_SETTINGS, setSetting } from '../src/lib/settings.js';

const SHOP = { lat: 30.6721, lng: 76.738 }; // Sector 82, Mohali
const SECTOR_15 = { lat: 30.7473, lng: 76.7672 }; // Chandigarh

const rule = { ...DEFAULT_SETTINGS, deliveryPerKmPaise: 300, freeDeliveryMinPaise: 200_000, storeLat: SHOP.lat, storeLng: SHOP.lng };
const fixed = (metres: number | null): DistanceLookup => async () => metres;

describe('delivery fee by distance', () => {
  it('is km × rate, rounded to the rupee, at least the minimum', () => {
    expect(distanceFeePaise(rule, 30)).toBe(9_000); // Vivek's example: 30 km × ₹3 = ₹90
    expect(distanceFeePaise(rule, 30.2)).toBe(9_100); // ₹90.60 → ₹91
    expect(distanceFeePaise({ ...rule, deliveryMinFeePaise: 3_000 }, 2)).toBe(3_000); // 2 km = ₹6, minimum ₹30
  });

  it('uses the road distance to the pinned address', async () => {
    const d = await deliveryPricing(rule, { lat: '30.7473', lng: '76.7672' }, fixed(30_240));
    expect(d.km).toBe(30.2);
    expect(d.fees.deliveryFeePaise).toBe(9_100);
    expect(d.tooFar).toBeNull();
  });

  it('falls back to the flat fee when it is off, the shop or the pin is missing, or Google fails', async () => {
    const flat = rule.deliveryFeePaise;
    expect((await deliveryPricing({ ...rule, deliveryPerKmPaise: 0 }, SECTOR_15, fixed(30_000))).fees.deliveryFeePaise).toBe(flat);
    expect((await deliveryPricing({ ...rule, storeLat: null }, SECTOR_15, fixed(30_000))).fees.deliveryFeePaise).toBe(flat);
    expect((await deliveryPricing(rule, { lat: null, lng: null }, fixed(30_000))).km).toBeNull();
    expect((await deliveryPricing(rule, SECTOR_15, fixed(null))).fees.deliveryFeePaise).toBe(flat);
  });

  it('flags addresses beyond the farthest distance', async () => {
    const d = await deliveryPricing({ ...rule, deliveryMaxKm: 25 }, SECTOR_15, fixed(30_000));
    expect(d.tooFar).toEqual({ km: 30, maxKm: 25 });
  });
});

describe('Google Routes lookup', () => {
  it('asks for the driving distance once per address and remembers it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ routes: [{ distanceMeters: 30_240 }] }), { status: 200 }));
    const lookup = googleDistanceLookup('test-key', fetchMock as unknown as typeof fetch);
    expect(await lookup(SHOP, SECTOR_15)).toBe(30_240);
    expect(await lookup(SHOP, SECTOR_15)).toBe(30_240);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key');
    expect((init.headers as Record<string, string>)['X-Goog-FieldMask']).toBe('routes.distanceMeters');
    expect(JSON.parse(init.body as string).origin.location.latLng).toEqual({ latitude: SHOP.lat, longitude: SHOP.lng });
  });

  it('gives no distance without a key, on an error, or when Google is unreachable', async () => {
    expect(await googleDistanceLookup(undefined)(SHOP, SECTOR_15)).toBeNull();
    const denied = vi.fn(async () => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }));
    expect(await googleDistanceLookup('k', denied as unknown as typeof fetch)(SHOP, SECTOR_15)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await googleDistanceLookup('k', down as unknown as typeof fetch)(SHOP, SECTOR_15)).toBeNull();
  });
});

describe('checkout with distance pricing', () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let token: string;
  let pinned: number;
  let noPin: number;
  let bulbId: number;
  let lampId: number;

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: body as never, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: res.json() as any };
  };
  const quote = (items: { productId: number; qty: number }[], addressId?: number) => call('POST', '/v1/cart/quote', { items, addressId });

  beforeAll(async () => {
    h = await openDb({ memory: true });
    app = await buildApp(h.db);
    const [bulb, lamp] = await h.db
      .insert(products)
      .values([
        { sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 50 },
        { sku: 'L1', slug: 'lamp', name: 'Floor Lamp', images: [], pricePaise: 250_000, mrpPaise: 300_000, stockQty: 5 },
      ])
      .returning();
    bulbId = bulb.id;
    lampId = lamp.id;
    const [u] = await h.db.insert(users).values({ name: 'Priya', phone: '9876500001' }).returning();
    token = await signAccessToken(u.id, 'customer');
    const addr = { label: 'home', name: 'Priya', phone: '9876500001', line1: '15, Sector 15', city: 'Chandigarh', state: 'Chandigarh', pincode: '160015' };
    pinned = (await call('POST', '/v1/addresses', { ...addr, lat: SECTOR_15.lat, lng: SECTOR_15.lng })).body.address.id;
    noPin = (await call('POST', '/v1/addresses', { ...addr, label: 'work' })).body.address.id;
    for (const [k, v] of Object.entries({ deliveryPerKmPaise: 300, freeDeliveryMinPaise: 200_000, storeLat: SHOP.lat, storeLng: SHOP.lng })) {
      await setSetting(h.db, k as 'deliveryPerKmPaise', v as number);
    }
    setDistanceLookup(fixed(30_000));
  });

  afterAll(async () => {
    setDistanceLookup(fixed(null));
    await app.close();
    await h.close();
  });

  it('charges ₹3/km to the pinned address and shows the km', async () => {
    const q = (await quote([{ productId: bulbId, qty: 1 }], pinned)).body;
    expect(q.deliveryKm).toBe(30);
    expect(q.deliveryFeePaise).toBe(9_000);
    expect(q.deliveryTooFar).toBeNull();
  });

  it('is free from ₹2,000, and flat for an address with no pin or no address yet', async () => {
    const big = (await quote([{ productId: lampId, qty: 1 }], pinned)).body;
    expect([big.deliveryFeePaise, big.deliveryFeeBeforeWaiverPaise]).toEqual([0, 9_000]);
    expect((await quote([{ productId: bulbId, qty: 1 }], noPin)).body).toMatchObject({ deliveryKm: null, deliveryFeePaise: 2_500 });
    expect((await quote([{ productId: bulbId, qty: 1 }])).body).toMatchObject({ deliveryKm: null, deliveryFeePaise: 2_500 });
  });

  it('charges the same at order time, and refuses addresses beyond the farthest distance', async () => {
    await call('PUT', '/v1/cart', { items: [{ productId: bulbId, qty: 1 }] });
    const o = await call('POST', '/v1/orders', { addressId: pinned, paymentMethod: 'cod', idempotencyKey: 'distance-order-1', distanceDelivery: true });
    expect(o.status).toBe(201);
    expect(o.body.deliveryFeePaise ?? o.body.bill?.deliveryFeePaise).toBe(9_000);

    await setSetting(h.db, 'deliveryMaxKm', 25);
    expect((await quote([{ productId: bulbId, qty: 1 }], pinned)).body.deliveryTooFar).toEqual({ km: 30, maxKm: 25 });
    await call('PUT', '/v1/cart', { items: [{ productId: bulbId, qty: 1 }] });
    const far = await call('POST', '/v1/orders', { addressId: pinned, paymentMethod: 'cod', idempotencyKey: 'distance-order-2', distanceDelivery: true });
    expect(far.status).toBe(400);
    expect(far.body.error.code).toBe('too_far');
    await setSetting(h.db, 'deliveryMaxKm', 0);
  });

  it('keeps the flat fee for older apps that never showed the distance fee', async () => {
    await call('PUT', '/v1/cart', { items: [{ productId: bulbId, qty: 1 }] });
    const o = await call('POST', '/v1/orders', { addressId: pinned, paymentMethod: 'cod', idempotencyKey: 'distance-order-old' });
    expect(o.status).toBe(201);
    expect(o.body.deliveryFeePaise ?? o.body.bill?.deliveryFeePaise).toBe(2_500);
  });
});
