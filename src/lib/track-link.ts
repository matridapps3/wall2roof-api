import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';

/**
 * The link a customer shares so someone else can follow their order without the app or a login:
 * /track/<order number>/<key>. The key is signed with the server's secret, so knowing an order
 * number isn't enough to see it; the page shows only the status, the items and the town.
 */
function trackKey(number: string): string {
  return createHmac('sha256', config.jwtSecret).update(`track:${number}`).digest('base64url').slice(0, 22);
}

export function trackPath(number: string): string {
  return `/track/${encodeURIComponent(number)}/${trackKey(number)}`;
}

export function isTrackKey(number: string, key: string): boolean {
  const want = Buffer.from(trackKey(number));
  const got = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}
