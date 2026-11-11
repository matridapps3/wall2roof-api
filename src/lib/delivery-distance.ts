import type { FeeSettings } from './pricing.js';
import type { StoreSettings } from './settings.js';

/**
 * Delivery priced by driving distance: Google Maps (Routes API) measures the road distance from the
 * shop to the customer's pinned address, and the fee is km × deliveryPerKmPaise (owner's rule:
 * ₹3/km, so Sector 82 Mohali → Sector 15 Chandigarh ≈ 30 km = ₹90), free above freeDeliveryMinPaise.
 *
 * Falls back to the flat deliveryFeePaise when the rate or the shop's location isn't set, the
 * address has no pin, there is no Google key, or Google doesn't answer — an order is never blocked
 * because Google is down.
 */

export type Point = { lat: number; lng: number };

/** Asks for the road distance in metres; null when it can't be measured. */
export type DistanceLookup = (from: Point, to: Point) => Promise<number | null>;

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX = 5000;

/** Google is asked once per shop→address pair (cached), which keeps the cost down. */
export function googleDistanceLookup(key: string | undefined, doFetch: typeof fetch = fetch): DistanceLookup {
  const cache = new Map<string, { metres: number; at: number }>();
  return async (from, to) => {
    if (!key) return null;
    const id = [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(5)).join(',');
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.metres;
    try {
      const res = await doFetch(ROUTES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters' },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
          destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { routes?: { distanceMeters?: number }[] };
      const metres = body.routes?.[0]?.distanceMeters;
      if (typeof metres !== 'number' || metres < 0) return null;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(id, { metres, at: Date.now() });
      return metres;
    } catch {
      return null;
    }
  };
}

export type DeliveryPricing = {
  /** the fees to price the cart with (deliveryFeePaise replaced by the distance fee when there is one) */
  fees: FeeSettings;
  /** road distance in km (one decimal), when measured */
  km: number | null;
  /** set when the address is farther than deliveryMaxKm: the order can't be placed */
  tooFar: { km: number; maxKm: number } | null;
};

type DeliverySettings = Pick<
  StoreSettings,
  'deliveryFeePaise' | 'freeDeliveryMinPaise' | 'handlingFeePaise' | 'codFeePaise' | 'deliveryPerKmPaise' | 'deliveryMinFeePaise' | 'deliveryMaxKm' | 'storeLat' | 'storeLng'
>;

/** km × rate, rounded to the rupee, at least the minimum fee. */
export function distanceFeePaise(s: Pick<StoreSettings, 'deliveryPerKmPaise' | 'deliveryMinFeePaise'>, km: number): number {
  return Math.max(Math.round((km * s.deliveryPerKmPaise) / 100) * 100, s.deliveryMinFeePaise);
}

const toPoint = (lat: unknown, lng: unknown): Point | null => {
  const a = lat == null || lat === '' ? NaN : Number(lat);
  const b = lng == null || lng === '' ? NaN : Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) ? { lat: a, lng: b } : null;
};

/** The delivery fee for this address (pin as stored on the address: text or number). */
export async function deliveryPricing(
  s: DeliverySettings,
  address: { lat: unknown; lng: unknown } | null,
  lookup: DistanceLookup,
): Promise<DeliveryPricing> {
  const flat: DeliveryPricing = { fees: s, km: null, tooFar: null };
  const shop = toPoint(s.storeLat, s.storeLng);
  const to = address ? toPoint(address.lat, address.lng) : null;
  if (s.deliveryPerKmPaise <= 0 || !shop || !to) return flat;
  const metres = await lookup(shop, to);
  if (metres == null) return flat;
  const km = Math.round(metres / 100) / 10;
  return {
    fees: { ...s, deliveryFeePaise: distanceFeePaise(s, km) },
    km,
    tooFar: s.deliveryMaxKm > 0 && km > s.deliveryMaxKm ? { km, maxKm: s.deliveryMaxKm } : null,
  };
}
