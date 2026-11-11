import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { googleGeocoder, inChosenCity, placeFrom, type Geocoder } from '../src/lib/google-geocode.js';

// a trimmed Google Geocoding API result for a point in Sector 82, Mohali
const result = {
  formatted_address: 'Plot 962, JLPL Industrial Area, Sector 82, Sahibzada Ajit Singh Nagar, Punjab 140306, India',
  geometry: { location: { lat: 30.6551, lng: 76.7334 } },
  address_components: [
    { long_name: '962', short_name: '962', types: ['premise'] },
    { long_name: 'Sector 82', short_name: 'Sector 82', types: ['neighborhood', 'political'] },
    { long_name: 'JLPL Industrial Area', short_name: 'JLPL Industrial Area', types: ['political', 'sublocality', 'sublocality_level_1'] },
    { long_name: 'Sahibzada Ajit Singh Nagar', short_name: 'Sahibzada Ajit Singh Nagar', types: ['administrative_area_level_3', 'political'] },
    { long_name: 'Ropar Division', short_name: 'Ropar Division', types: ['administrative_area_level_2', 'political'] },
    { long_name: 'Punjab', short_name: 'PB', types: ['administrative_area_level_1', 'political'] },
    { long_name: 'India', short_name: 'IN', types: ['country', 'political'] },
    { long_name: '140306', short_name: '140306', types: ['postal_code'] },
  ],
};
const ok = () => new Response(JSON.stringify({ status: 'OK', results: [result] }), { status: 200 });

describe('Google Maps addresses', () => {
  it('turns Google address parts into the address form fields', () => {
    expect(placeFrom(result)).toEqual({
      name: '962',
      street: null,
      district: 'Sector 82, JLPL Industrial Area',
      city: 'Mohali',
      subregion: 'Ropar Division',
      region: 'Punjab',
      postalCode: '140306',
    });
  });

  it('asks Google once per spot (with the key, India first) and finds addresses', async () => {
    const fetchMock = vi.fn(async () => ok());
    const g = googleGeocoder('test-key', fetchMock as unknown as typeof fetch);
    expect((await g.reverse(30.65512, 76.73341))?.postalCode).toBe('140306');
    expect((await g.reverse(30.65514, 76.73339))?.district).toBe('Sector 82, JLPL Industrial Area'); // same ~11 m spot
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect([url.searchParams.get('latlng'), url.searchParams.get('key'), url.searchParams.get('region')]).toEqual(['30.65512,76.73341', 'test-key', 'in']);

    expect(await g.forward('Plot 962, Sector 82, JLPL, Mohali')).toEqual({ lat: 30.6551, lng: 76.7334, formatted: result.formatted_address });
  });

  it('gives nothing without a key, when Google says no, or when it is unreachable', async () => {
    expect(await googleGeocoder(undefined).reverse(30.65, 76.73)).toBeNull();
    const denied = vi.fn(async () => new Response(JSON.stringify({ status: 'REQUEST_DENIED', results: [] }), { status: 200 }));
    expect(await googleGeocoder('k', denied as unknown as typeof fetch).reverse(30.65, 76.73)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await googleGeocoder('k', down as unknown as typeof fetch).forward('anywhere')).toBeNull();
  });
});

describe('Google Places search (New API)', () => {
  it('turns suggestions and the picked place into what the form needs', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes(':autocomplete')
        ? new Response(JSON.stringify({ suggestions: [{ placePrediction: { placeId: 'ChIJabc123xyz', structuredFormat: { mainText: { text: 'Mouli Jagran' }, secondaryText: { text: 'Chandigarh, India' } } } }] }), { status: 200 })
        : new Response(
            JSON.stringify({
              displayName: { text: 'Mouli Jagran' },
              formattedAddress: 'Mouli Jagran, Chandigarh, 160101, India',
              location: { latitude: 30.7046, longitude: 76.8346 },
              addressComponents: [
                { longText: 'Mouli Jagran', shortText: 'Mouli Jagran', types: ['sublocality_level_1', 'sublocality', 'political'] },
                { longText: 'Chandigarh', shortText: 'Chandigarh', types: ['locality', 'political'] },
                { longText: 'Chandigarh', shortText: 'CH', types: ['administrative_area_level_1', 'political'] },
                { longText: '160101', shortText: '160101', types: ['postal_code'] },
              ],
            }),
            { status: 200 },
          ),
    );
    const g = googleGeocoder('test-key', fetchMock as unknown as typeof fetch);
    expect(await g.search('mouli', 'session123', { near: { lat: 30.65, lng: 76.73 } })).toEqual([{ placeId: 'ChIJabc123xyz', title: 'Mouli Jagran', subtitle: 'Chandigarh, India' }]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ input: 'mouli', sessionToken: 'session123', includedRegionCodes: ['in'] });
    expect(await g.details('ChIJabc123xyz', 'session123')).toMatchObject({
      title: 'Mouli Jagran',
      district: 'Mouli Jagran',
      city: 'Chandigarh',
      region: 'Chandigarh',
      postalCode: '160101',
      lat: 30.7046,
      lng: 76.8346,
    });
  });
});

describe('Blinkit-style city, then area in that city', () => {
  const prediction = (placeId: string, main: string, secondary: string, distanceMeters?: number) => ({
    placePrediction: { placeId, structuredFormat: { mainText: { text: main }, secondaryText: { text: secondary } }, text: { text: `${main}, ${secondary}` }, distanceMeters },
  });

  it('shows only the chosen city’s areas (Mohali’s places may say Sahibzada Ajit Singh Nagar), with their distance', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            suggestions: [
              prediction('ChIJsector70xx', 'Sector 70', 'Sahibzada Ajit Singh Nagar, Punjab, India', 5300),
              prediction('ChIJsector7chd', 'Sector 7', 'Chandigarh, India', 9100),
              prediction('ChIJsector79xx', 'Sector 79', 'Mohali, Punjab, India', 3600),
            ],
          }),
          { status: 200 },
        ),
    );
    const g = googleGeocoder('k', fetchMock as unknown as typeof fetch);
    const found = await g.search('sector 7', 'session123', { city: { name: 'Mohali', lat: 30.7046, lng: 76.7179 }, origin: { lat: 30.65, lng: 76.73 } });
    // nearest first, and Mohali called Mohali
    expect(found).toEqual([
      { placeId: 'ChIJsector79xx', title: 'Sector 79', subtitle: 'Mohali, Punjab, India', distanceMeters: 3600 },
      { placeId: 'ChIJsector70xx', title: 'Sector 70', subtitle: 'Mohali, Punjab, India', distanceMeters: 5300 },
    ]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.locationRestriction.circle).toEqual({ center: { latitude: 30.7046, longitude: 76.7179 }, radius: 20000 });
    expect(body.origin).toEqual({ latitude: 30.65, longitude: 76.73 });
    expect(body.locationBias).toBeUndefined();
  });

  it('searches cities only, and opens the picked one with its state and centre', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes(':autocomplete')
        ? new Response(JSON.stringify({ suggestions: [prediction('ChIJmohalicity', 'Sahibzada Ajit Singh Nagar', 'Punjab, India')] }), { status: 200 })
        : new Response(
            JSON.stringify({
              displayName: { text: 'Mohali' },
              location: { latitude: 30.7046, longitude: 76.7179 },
              addressComponents: [{ longText: 'Punjab', shortText: 'PB', types: ['administrative_area_level_1', 'political'] }],
            }),
            { status: 200 },
          ),
    );
    const g = googleGeocoder('k', fetchMock as unknown as typeof fetch);
    expect(await g.cities('moh', 'session123')).toEqual([{ placeId: 'ChIJmohalicity', name: 'Mohali', region: 'Punjab' }]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.includedPrimaryTypes).toEqual(['(cities)']);
    expect(await g.city('ChIJmohalicity', 'session123')).toEqual({ name: 'Mohali', region: 'Punjab', lat: 30.7046, lng: 76.7179 });
  });

  it('keeps a search in the chosen city: Mohali never shows Chandigarh, even when typed', () => {
    const mohali = { name: 'Mohali', region: 'Punjab' };
    // real Google texts
    expect(inChosenCity('Sector 82, JLPL Industrial Area, Punjab, India', mohali)).toBe(true); // Google leaves Mohali out
    expect(inChosenCity('Phase 7, Sector 61, Sahibzada Ajit Singh Nagar, Punjab, India', mohali)).toBe(true);
    expect(inChosenCity('JLPL Galaxy Heights 1, Chandigarh International Airport Road, Industrial Area Phase 9, Sahibzada Ajit Singh Nagar, Punjab, India', mohali)).toBe(true);
    expect(inChosenCity('Sector 43, Chandigarh, India', mohali)).toBe(false);
    expect(inChosenCity('Chandigarh Road, Kajheri Village, Sector 43, Chandigarh, India', mohali)).toBe(false);
    expect(inChosenCity('Sunny Enclave, Zirakpur, Punjab, India', mohali)).toBe(false);
    const chandigarh = { name: 'Chandigarh', region: 'Chandigarh' };
    expect(inChosenCity('Sector 43, Chandigarh, India', chandigarh)).toBe(true);
    expect(inChosenCity('Sector 82, JLPL Industrial Area, Punjab, India', chandigarh)).toBe(false);
    expect(inChosenCity('Phase 7, Sector 61, Sahibzada Ajit Singh Nagar, Punjab, India', chandigarh)).toBe(false);
  });

  it('calls Mohali "Mohali", not Google’s official name', () => {
    const r = { ...result, address_components: result.address_components.map((c) => (c.types.includes('administrative_area_level_3') ? { ...c, types: ['locality', 'political'] } : c)) };
    expect(placeFrom(r).city).toBe('Mohali');
  });
});

describe('GET /v1/geo/reverse', () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let answer: boolean;
  const geocoder: Geocoder = {
    reverse: async () => (answer ? placeFrom(result) : null),
    forward: async () => null,
    search: async (input) => (answer ? [{ placeId: 'ChIJ_test_place_1', title: input, subtitle: 'Chandigarh, India' }] : null),
    details: async () => (answer ? { ...placeFrom(result), title: 'JLPL', formatted: result.formatted_address, lat: 30.65, lng: 76.73 } : null),
    cities: async () => (answer ? [{ placeId: 'ChIJ_city_moh', name: 'Mohali', region: 'Punjab' }] : null),
    city: async () => (answer ? { name: 'Mohali', region: 'Punjab', lat: 30.7046, lng: 76.7179 } : null),
  };

  beforeAll(async () => {
    h = await openDb({ memory: true });
    app = await buildApp(h.db, {}, { geocoder });
  });
  afterAll(async () => {
    await app.close();
    await h.close();
  });

  const get = (qs: string) => app.inject({ method: 'GET', url: `/v1/geo/reverse?${qs}` });

  it('answers with the place from Google, logged out too', async () => {
    answer = true;
    const r = await get('lat=30.6551&lng=76.7334');
    expect(r.statusCode).toBe(200);
    expect(r.json().place).toMatchObject({ district: 'Sector 82, JLPL Industrial Area', region: 'Punjab', postalCode: '140306' });
  });

  it('says so when Google cannot answer, and rejects points outside India', async () => {
    answer = false;
    expect((await get('lat=30.6551&lng=76.7334')).statusCode).toBe(503);
    expect((await get('lat=51.5&lng=-0.12')).statusCode).toBe(400);
  });

  it('searches places and opens the picked one', async () => {
    answer = true;
    const s = await app.inject({ method: 'GET', url: '/v1/geo/search?q=mouli%20jagran&session=abcdef123456' });
    expect(s.statusCode).toBe(200);
    expect(s.json().results[0]).toMatchObject({ placeId: 'ChIJ_test_place_1', title: 'mouli jagran' });
    const p = await app.inject({ method: 'GET', url: '/v1/geo/place/ChIJ_test_place_1?session=abcdef123456' });
    expect(p.json().place).toMatchObject({ title: 'JLPL', postalCode: '140306', lat: 30.65 });
    expect((await app.inject({ method: 'GET', url: '/v1/geo/search?q=a&session=abcdef123456' })).statusCode).toBe(400); // too short
  });

  it('searches cities and opens the picked one', async () => {
    answer = true;
    const c = await app.inject({ method: 'GET', url: '/v1/geo/cities?q=moh&session=abcdef123456' });
    expect(c.json().results[0]).toMatchObject({ name: 'Mohali', region: 'Punjab' });
    const one = await app.inject({ method: 'GET', url: '/v1/geo/city/ChIJ_city_moh?session=abcdef123456' });
    expect(one.json().city).toEqual({ name: 'Mohali', region: 'Punjab', lat: 30.7046, lng: 76.7179 });
    const area = await app.inject({ method: 'GET', url: '/v1/geo/search?q=sector&session=abcdef123456&city=Mohali&clat=30.7046&clng=76.7179&olat=30.65&olng=76.73' });
    expect(area.statusCode).toBe(200);
  });

  it('limits how often one device can look up', async () => {
    answer = true;
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await get(`lat=30.6${i}&lng=76.73`)).statusCode;
    expect(last).toBe(429);
  });
});
