import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HttpError, parse } from '../http.js';
import type { Geocoder } from '../lib/google-geocode.js';

/** Per IP: plenty for picking a location, pinning a door or searching an area, not enough to run up the Google bill. */
const LIMIT = 120;
const WINDOW_MS = 10 * 60_000;

/**
 * GET /v1/geo/reverse?lat=&lng= — the street, area, city, state and PIN at a GPS point, from Google
 * Maps (for "Use my current location" and pinning the door). Works logged out (choosing a delivery
 * location comes before login). 503 when Google can't answer: the customer types the address instead.
 */
export async function geoRoutes(app: FastifyInstance, { geocoder }: { geocoder: Geocoder }) {
  const hits = new Map<string, number[]>();

  const allow = (ip: string) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= LIMIT) throw new HttpError(429, 'too_many_requests', 'Too many location lookups. Type the address instead.');
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10_000) hits.clear();
  };
  const session = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

  const lat = z.coerce.number().min(5).max(38).optional();
  const lng = z.coerce.number().min(67).max(99).optional();
  const point = (a?: number, b?: number) => (a != null && b != null ? { lat: a, lng: b } : undefined);

  /**
   * GET /v1/geo/search?q=&session=&lat=&lng=&city=&clat=&clng=&olat=&olng= — Blinkit's "Select an area,
   * street": places in India for what the customer types (Google Places). With a city (its name and
   * centre, from "Select a city") only places in that city; otherwise nearest the shop / phone (lat/lng)
   * first. olat/olng = where the phone is, for each result's "3.6 km". session = one id per search,
   * shared with the /v1/geo/place call that ends it (Google bills a typed search + its pick as one).
   */
  app.get('/v1/geo/search', async (req) => {
    const q = parse(
      z.object({
        q: z.string().trim().min(2).max(120),
        session,
        lat,
        lng,
        city: z.string().trim().min(2).max(80).optional(),
        // the city's state, e.g. Punjab: places Google leaves the town out of are kept when they're in it
        cstate: z.string().trim().min(2).max(80).optional(),
        clat: lat,
        clng: lng,
        olat: lat,
        olng: lng,
      }),
      req.query,
    );
    allow(req.ip);
    const centre = point(q.clat, q.clng);
    const results = await geocoder.search(q.q, q.session, {
      near: point(q.lat, q.lng),
      city: q.city && centre ? { name: q.city, region: q.cstate, ...centre } : undefined,
      origin: point(q.olat, q.olng),
    });
    if (!results) throw new HttpError(503, 'geocode_unavailable', 'Search isn’t working right now. Type the address instead.');
    return { results };
  });

  /** GET /v1/geo/cities?q=&session= — Blinkit's "Search for a city": cities in India (Google Places). */
  app.get('/v1/geo/cities', async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(80), session }), req.query);
    allow(req.ip);
    const results = await geocoder.cities(q.q, q.session);
    if (!results) throw new HttpError(503, 'geocode_unavailable', 'City search isn’t working right now. Try again.');
    return { results };
  });

  /** GET /v1/geo/city/:id?session= — the picked city: its name, state and centre (for the area search). */
  app.get('/v1/geo/city/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^[\w-]{10,300}$/) }), req.params);
    const q = parse(z.object({ session }), req.query);
    allow(req.ip);
    const city = await geocoder.city(id, q.session);
    if (!city) throw new HttpError(503, 'geocode_unavailable', 'Couldn’t open this city. Try another.');
    return { city };
  });

  /** GET /v1/geo/place/:id?session= — the picked place: area, city, state, PIN and its point. */
  app.get('/v1/geo/place/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^[\w-]{10,300}$/) }), req.params);
    const q = parse(z.object({ session }), req.query);
    allow(req.ip);
    const place = await geocoder.details(id, q.session);
    if (!place) throw new HttpError(503, 'geocode_unavailable', 'Couldn’t open this place. Try another or type the address.');
    return { place };
  });

  app.get('/v1/geo/reverse', async (req) => {
    const q = parse(
      z.object({
        // India and around it
        lat: z.coerce.number().min(5).max(38),
        lng: z.coerce.number().min(67).max(99),
      }),
      req.query,
    );
    allow(req.ip);
    const place = await geocoder.reverse(q.lat, q.lng);
    if (!place) throw new HttpError(503, 'geocode_unavailable', 'Couldn’t look up this location. Type the address instead.');
    return { place };
  });
}
