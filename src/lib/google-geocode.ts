/**
 * Addresses from Google Maps (Geocoding API), so the whole app uses Google's map data — not the
 * phone's own geocoder (Apple Maps on iPhone) or OpenStreetMap:
 *  - reverse: a GPS point → street, area, city, state, PIN (filling in the address form)
 *  - forward: a typed address → its point (e.g. the shop's location)
 * Same key as the delivery distance (GOOGLE_MAPS_SERVER_KEY, with the Geocoding API on).
 */

export type Place = {
  /** house / building or point of interest name */
  name: string | null;
  street: string | null;
  /** neighbourhood / sector, e.g. "Sector 82" */
  district: string | null;
  city: string | null;
  /** district, e.g. "Sahibzada Ajit Singh Nagar" */
  subregion: string | null;
  /** state, e.g. "Punjab" */
  region: string | null;
  postalCode: string | null;
};

type Component = { long_name: string; short_name: string; types: string[] };
type Result = { address_components: Component[]; formatted_address: string; geometry: { location: { lat: number; lng: number } } };

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const TIMEOUT_MS = 5000;
const CACHE_MAX = 5000;

function pick(components: Component[], ...types: string[]): string | null {
  for (const t of types) {
    const c = components.find((x) => x.types.includes(t));
    if (c) return c.long_name;
  }
  return null;
}

/** Google's official names → the names people use (and Blinkit shows): "Sahibzada Ajit Singh Nagar" is Mohali. */
const CITY_NAMES: Record<string, string> = {
  'sahibzada ajit singh nagar': 'Mohali',
  'sas nagar': 'Mohali',
  's.a.s. nagar': 'Mohali',
  'ajitgarh': 'Mohali',
};
export function cityName(name: string | null): string | null {
  return name ? (CITY_NAMES[name.trim().toLowerCase()] ?? name) : null;
}
/** "Sector 79, Sahibzada Ajit Singh Nagar, Punjab" → "Sector 79, Mohali, Punjab". */
function commonNames(text: string): string {
  return text
    .split(', ')
    .map((part) => cityName(part) ?? part)
    .join(', ');
}
/** Every name a city's places may carry in Google's text, e.g. Mohali's places often say "Sahibzada Ajit Singh Nagar". */
function cityAliases(name: string): string[] {
  const n = name.trim().toLowerCase();
  return [n, ...Object.entries(CITY_NAMES).filter(([, v]) => v.toLowerCase() === n).map(([k]) => k)];
}

/** The towns around the shop, by every name Google uses: a place naming one of them is in that town. */
const NEARBY_CITIES = ['chandigarh', 'mohali', ...Object.keys(CITY_NAMES), 'panchkula', 'zirakpur', 'kharar', 'dera bassi', 'kurali', 'rajpura', 'new chandigarh'];

/**
 * Is this place (Google's full text, e.g. "Sector 43, Chandigarh, India") in the chosen city? Yes when it
 * names the city; otherwise when it's in the city's state and names no other nearby town — Google often
 * leaves the town out ("Sector 82, JLPL Industrial Area, Punjab" is Mohali), but "Sector 43, Chandigarh"
 * is not Mohali, however close.
 */
export function inChosenCity(text: string, city: { name: string; region?: string | null }): boolean {
  const t = text.toLowerCase();
  const names = cityAliases(city.name);
  if (names.some((n) => t.includes(n))) return true;
  const parts = t.split(',').map((p) => p.trim());
  if (parts.some((p) => NEARBY_CITIES.includes(p))) return false;
  return !!city.region && parts.includes(city.region.trim().toLowerCase());
}

/** Google's address parts → the same fields the app's address form already uses. */
export function placeFrom(result: Result): Place {
  const c = result.address_components;
  const number = pick(c, 'street_number');
  const route = pick(c, 'route');
  return {
    name: pick(c, 'premise', 'establishment', 'point_of_interest'),
    street: [number, route].filter(Boolean).join(' ') || null,
    // In India Google often gives both, e.g. neighborhood "Sector 82" and sublocality "JLPL Industrial Area"
    district:
      [...new Set([pick(c, 'neighborhood'), pick(c, 'sublocality_level_1', 'sublocality', 'sublocality_level_2')].filter((v): v is string => !!v))].join(', ') ||
      null,
    city: cityName(pick(c, 'locality', 'administrative_area_level_3')),
    subregion: pick(c, 'administrative_area_level_2'),
    region: pick(c, 'administrative_area_level_1'),
    postalCode: pick(c, 'postal_code'),
  };
}

/** One suggestion while typing "Area, street" (Blinkit's search); distanceMeters = straight line from the phone. */
export type Suggestion = { placeId: string; title: string; subtitle: string; distanceMeters?: number };

/** A picked place: what the address form fills in, plus its point (pinned like "Use my location"). */
export type PlaceDetails = Place & { title: string; formatted: string; lat: number; lng: number };

type Point = { lat: number; lng: number };
/** The city chosen in "Select a city": the area search shows only places in it. */
export type CityFilter = Point & { name: string; region?: string | null };
export type SearchOptions = { near?: Point; city?: CityFilter; origin?: Point };
/** A city from "Search for a city", and the one picked (its centre, for the area search). */
export type CitySuggestion = { placeId: string; name: string; region: string };
export type CityDetails = { name: string; region: string | null; lat: number; lng: number };

export type Geocoder = {
  reverse(lat: number, lng: number): Promise<Place | null>;
  forward(address: string): Promise<{ lat: number; lng: number; formatted: string } | null>;
  /** Places search (Google Places API, New) for what the customer types: near the shop / phone, or only in the chosen city */
  search(input: string, session: string, opts?: SearchOptions): Promise<Suggestion[] | null>;
  details(placeId: string, session: string): Promise<PlaceDetails | null>;
  /** Blinkit's "Search for a city": cities in India only */
  cities(input: string, session: string): Promise<CitySuggestion[] | null>;
  city(placeId: string, session: string): Promise<CityDetails | null>;
};

/** How far around the chosen city's centre its areas are looked for (the text filter below does the rest). */
const CITY_RADIUS_M = 20_000;

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACE_URL = 'https://places.googleapis.com/v1/places/';

type NewComponent = { longText: string; shortText: string; types: string[] };
type Prediction = {
  placeId: string;
  structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
  text?: { text: string };
  distanceMeters?: number;
};
type NewPlace = { displayName?: { text: string }; formattedAddress?: string; addressComponents?: NewComponent[]; location?: { latitude: number; longitude: number } };

export function googleGeocoder(key: string | undefined, doFetch: typeof fetch = fetch): Geocoder {
  const cache = new Map<string, Place | null>();
  const call = async (params: Record<string, string>): Promise<Result[] | null> => {
    if (!key) return null;
    try {
      const url = `${GEOCODE_URL}?${new URLSearchParams({ ...params, key, language: 'en', region: 'in' })}`;
      const res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = (await res.json()) as { status: string; results?: Result[] };
      return body.status === 'OK' && body.results?.length ? body.results : null;
    } catch {
      return null;
    }
  };
  /** Places Autocomplete (New); null when Google can't answer. */
  const autocomplete = async (body: object): Promise<Prediction[] | null> => {
    if (!key) return null;
    try {
      const res = await doFetch(AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { suggestions?: { placePrediction?: Prediction }[] };
      return (json.suggestions ?? []).flatMap((s) => (s.placePrediction?.placeId ? [s.placePrediction] : []));
    } catch {
      return null;
    }
  };
  /** Place Details (New) with only the fields asked for (fewer fields = cheaper); ends the search session. */
  const placeById = async (placeId: string, session: string, fields: string): Promise<NewPlace | null> => {
    if (!key || !/^[\w-]{10,300}$/.test(placeId)) return null;
    try {
      const res = await doFetch(`${PLACE_URL}${placeId}?${new URLSearchParams({ sessionToken: session, languageCode: 'en', regionCode: 'in' })}`, {
        headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res.ok ? ((await res.json()) as NewPlace) : null;
    } catch {
      return null;
    }
  };
  const geocoder: Geocoder = {
    async reverse(lat, lng) {
      // ~11 m: two taps at the same door share one Google lookup
      const id = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      if (cache.has(id)) return cache.get(id)!;
      const results = await call({ latlng: `${lat},${lng}` });
      if (!results) return null; // not cached: try Google again next time
      const place = placeFrom(results[0]);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(id, place);
      return place;
    },
    async forward(address) {
      const results = await call({ address, components: 'country:IN' });
      if (!results) return null;
      const r = results[0];
      return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted: r.formatted_address };
    },
    async search(input, session, opts = {}) {
      const { near, city, origin } = opts;
      const circle = (p: Point, radius: number) => ({ circle: { center: { latitude: p.lat, longitude: p.lng }, radius } });
      const found = await autocomplete({
        input,
        sessionToken: session,
        includedRegionCodes: ['in'],
        languageCode: 'en',
        // in a chosen city: only places around it (like Blinkit); otherwise near the shop / phone first
        ...(city ? { locationRestriction: circle(city, CITY_RADIUS_M) } : near ? { locationBias: circle(near, 50_000) } : {}),
        ...(origin ? { origin: { latitude: origin.lat, longitude: origin.lng } } : {}),
      });
      if (!found) return null;
      const all = found.map((p) => ({
        placeId: p.placeId,
        title: commonNames(p.structuredFormat?.mainText?.text ?? p.text?.text ?? ''),
        subtitle: commonNames(p.structuredFormat?.secondaryText?.text ?? ''),
        ...(p.distanceMeters != null ? { distanceMeters: p.distanceMeters } : {}),
        text: (p.text?.text ?? '').toLowerCase(),
      }));
      // the circle reaches the next town (Mohali's reaches Chandigarh): only the chosen city's places, like
      // Blinkit — "sector 43 chandigarh" in Mohali finds nothing rather than Chandigarh's Sector 43
      const shown = (city ? all.filter((s) => inChosenCity(s.text, city)) : all).map(({ text: _text, ...s }) => s);
      // in a city, nearest first, like Blinkit's "3.6 km, 4.2 km, 5.3 km"
      return city && shown.every((s) => s.distanceMeters != null) ? shown.sort((a, b) => a.distanceMeters! - b.distanceMeters!) : shown;
    },
    async cities(input, session) {
      const found = await autocomplete({ input, sessionToken: session, includedRegionCodes: ['in'], languageCode: 'en', includedPrimaryTypes: ['(cities)'] });
      if (!found) return null;
      return found.map((p) => ({
        placeId: p.placeId,
        name: cityName(p.structuredFormat?.mainText?.text ?? p.text?.text ?? '') ?? '',
        region: (p.structuredFormat?.secondaryText?.text ?? '').replace(/,?\s*India$/, ''),
      }));
    },
    async city(placeId, session) {
      const p = await placeById(placeId, session, 'displayName,addressComponents,location');
      if (!p?.location) return null;
      const region = (p.addressComponents ?? []).find((c) => c.types.includes('administrative_area_level_1'))?.longText ?? null;
      return { name: cityName(p.displayName?.text ?? '') ?? '', region, lat: p.location.latitude, lng: p.location.longitude };
    },
    async details(placeId, session) {
      try {
        const p = await placeById(placeId, session, 'displayName,formattedAddress,addressComponents,location');
        if (!p?.location) return null;
        const place = placeFrom({
          address_components: (p.addressComponents ?? []).map((c) => ({ long_name: c.longText, short_name: c.shortText, types: c.types })),
          formatted_address: p.formattedAddress ?? '',
          geometry: { location: { lat: p.location.latitude, lng: p.location.longitude } },
        });
        // an area / landmark often comes without a PIN (or city): take it from the address at that spot
        if (!place.postalCode || !place.city || !place.region) {
          const here = await geocoder.reverse(p.location.latitude, p.location.longitude);
          if (here) {
            place.postalCode ??= here.postalCode;
            place.city ??= here.city ?? here.subregion;
            place.region ??= here.region;
          }
        }
        return { ...place, title: p.displayName?.text ?? place.name ?? '', formatted: p.formattedAddress ?? '', lat: p.location.latitude, lng: p.location.longitude };
      } catch {
        return null;
      }
    },
  };
  return geocoder;
}
