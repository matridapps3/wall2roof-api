/**
 * Distance-based delivery settings (rupees, km). Only the options given change; the rest stay.
 * Uses DATABASE_URL like the other scripts.
 *
 *   npm run delivery:set -- --per-km 3 --free-above 2000 --min 30 --shop-address "Plot 962, Sector 82, JLPL, Mohali"
 *   npm run delivery:set -- --shop 30.6721,76.7380      (exact point, e.g. long-pressed in Google Maps)
 *   npm run delivery:set -- --min 30 --max-km 40
 *   npm run delivery:set -- --flat 25          (fee for addresses with no pin)
 *   npm run delivery:set -- --per-km 0         (switch distance pricing off: flat fee for everyone)
 *   npm run delivery:set                       (just show the current settings)
 *
 * Also needs GOOGLE_MAPS_SERVER_KEY (Routes API) on the server.
 */
import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { googleGeocoder } from '../lib/google-geocode.js';
import { getSettings, setSetting } from '../lib/settings.js';

const args = process.argv.slice(2);
const opts = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || args[i + 1] == null) {
    console.error('Usage: npm run delivery:set -- [--per-km ₹] [--free-above ₹] [--min ₹] [--max-km km] [--flat ₹] [--shop lat,lng] [--shop-address "address"]');
    process.exit(1);
  }
  opts.set(args[i].slice(2), args[i + 1]);
}

const rupees = (name: string): number | undefined => {
  const v = opts.get(name);
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) {
    console.error(`--${name} must be an amount in rupees, like 3 or 2000.`);
    process.exit(1);
  }
  return Math.round(n * 100);
};

const known = new Set(['per-km', 'free-above', 'min', 'max-km', 'flat', 'shop', 'shop-address']);
const unknown = [...opts.keys()].find((k) => !known.has(k));
if (unknown) {
  console.error(`Unknown option --${unknown}.`);
  process.exit(1);
}

const perKm = rupees('per-km');
const freeAbove = rupees('free-above');
const min = rupees('min');
const flat = rupees('flat');
const maxKmRaw = opts.get('max-km');
const maxKm = maxKmRaw == null ? undefined : Number(maxKmRaw);
if (maxKm !== undefined && (!Number.isFinite(maxKm) || maxKm < 0 || maxKm > 500)) {
  console.error('--max-km must be a distance in km (0 = no limit).');
  process.exit(1);
}
let shop: { lat: number; lng: number } | undefined;
if (opts.has('shop')) {
  const [lat, lng] = opts.get('shop')!.split(',').map((x) => Number(x.trim()));
  // India roughly: 6–37° N, 68–98° E
  if (!(lat >= 6 && lat <= 37 && lng >= 68 && lng <= 98)) {
    console.error('--shop must be the shop\'s "latitude,longitude" from Google Maps, like 30.6721,76.7380.');
    process.exit(1);
  }
  shop = { lat, lng };
}

if (opts.has('shop-address')) {
  // the shop's point from Google Maps (needs GOOGLE_MAPS_SERVER_KEY with the Geocoding API on)
  if (!config.GOOGLE_MAPS_SERVER_KEY) {
    console.error('--shop-address needs GOOGLE_MAPS_SERVER_KEY on this machine. Or give the exact point with --shop lat,lng.');
    process.exit(1);
  }
  const found = await googleGeocoder(config.GOOGLE_MAPS_SERVER_KEY).forward(opts.get('shop-address')!);
  if (!found) {
    console.error('Google Maps couldn’t find that address (or the Geocoding API is off for the key). Try --shop lat,lng.');
    process.exit(1);
  }
  shop = { lat: Number(found.lat.toFixed(6)), lng: Number(found.lng.toFixed(6)) };
  console.log(`Google Maps found: ${found.formatted} (${shop.lat}, ${shop.lng})`);
}

const { db, close } = await openDb();
if (perKm !== undefined) await setSetting(db, 'deliveryPerKmPaise', perKm);
if (freeAbove !== undefined) await setSetting(db, 'freeDeliveryMinPaise', freeAbove);
if (min !== undefined) await setSetting(db, 'deliveryMinFeePaise', min);
if (flat !== undefined) await setSetting(db, 'deliveryFeePaise', flat);
if (maxKm !== undefined) await setSetting(db, 'deliveryMaxKm', maxKm);
if (shop) {
  await setSetting(db, 'storeLat', shop.lat);
  await setSetting(db, 'storeLng', shop.lng);
}
const s = await getSettings(db);
await close();

const r = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
console.log(opts.size ? 'Saved.' : 'Current delivery settings:');
console.log(`  Per km: ${s.deliveryPerKmPaise ? r(s.deliveryPerKmPaise) : 'off (flat fee for everyone)'}`);
console.log(`  Free delivery from: ${r(s.freeDeliveryMinPaise)}`);
console.log(`  Minimum fee: ${s.deliveryMinFeePaise ? r(s.deliveryMinFeePaise) : 'none'}`);
console.log(`  Farthest delivery: ${s.deliveryMaxKm ? `${s.deliveryMaxKm} km` : 'no limit'}`);
console.log(`  Flat fee (no pin / Google not answering): ${r(s.deliveryFeePaise)}`);
console.log(`  Shop location: ${s.storeLat != null && s.storeLng != null ? `${s.storeLat}, ${s.storeLng}` : 'not set (flat fee is used)'}`);
console.log(`  Google key on this machine: ${config.GOOGLE_MAPS_SERVER_KEY ? 'set' : 'not set (the live server needs GOOGLE_MAPS_SERVER_KEY in Railway)'}`);
if (!config.DATABASE_URL) console.log(`(No DATABASE_URL, so this went to the local database in ${config.PGLITE_DIR}, not the live server.)`);
