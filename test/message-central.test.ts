import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.OTP_PROVIDER = 'messagecentral';
  process.env.MESSAGECENTRAL_CUSTOMER_ID = 'C-TEST';
  process.env.MESSAGECENTRAL_PASSWORD = 'pa55word';
  process.env.REVIEW_PHONE = '9876543210';
  process.env.REVIEW_OTP = '246810';
});

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';

let h: DbHandle;
let app: FastifyInstance;

const JWT = `eyJhbGciOiJIUzUxMiJ9.${Buffer.from(JSON.stringify({ sub: 'C-TEST', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sentOk = (id: string) => json({ responseCode: 200, message: 'SUCCESS', data: { verificationId: id, responseCode: '200', timeout: '60' } });

/** Message Central's answers, swapped per test; every call is recorded. */
let onSend: (q: URLSearchParams) => Response;
let onValidate: (q: URLSearchParams) => Response;
let calls: { path: string; q: URLSearchParams; method: string; headers: Record<string, string> }[];

async function post(url: string, body: unknown) {
  const res = await app.inject({ method: 'POST', url, payload: body as object });
  return { status: res.statusCode, body: res.json() as any };
}
const tokenCalls = () => calls.filter((c) => c.path === '/auth/v1/authentication/token').length;

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== 'cpaas.messagecentral.com') throw new Error(`unexpected fetch ${url}`);
    calls.push({ path: url.pathname, q: url.searchParams, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.pathname === '/auth/v1/authentication/token') return json({ status: 200, token: JWT });
    if (url.pathname === '/verification/v3/send') return onSend(url.searchParams);
    if (url.pathname === '/verification/v3/validateOtp') return onValidate(url.searchParams);
    return json({}, 404);
  });
});

beforeEach(() => {
  calls = [];
  onSend = () => sentOk('VID1');
  onValidate = (q) =>
    q.get('code') === '123456'
      ? json({ responseCode: 200, message: 'SUCCESS', data: { verificationStatus: 'VERIFICATION_COMPLETED', responseCode: '200' } })
      : json({ responseCode: 702, message: 'WRONG_OTP_PROVIDED', data: null }, 400);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  await h.close();
});

describe('login codes by Message Central', () => {
  it('sends a 6-digit code through Message Central and checks it there', async () => {
    const sent = await post('/v1/auth/otp/request', { phone: '9811111111' });
    expect(sent.status).toBe(200);
    expect(sent.body.devCode).toBeUndefined();
    expect(sent.body.resendInSec).toBe(60); // Message Central's wait, longer than ours

    const [login, send] = calls;
    expect(login.q.get('customerId')).toBe('C-TEST');
    expect(login.q.get('key')).toBe(Buffer.from('pa55word').toString('base64'));
    expect(send).toMatchObject({ path: '/verification/v3/send', method: 'POST', headers: { authToken: JWT } });
    expect(Object.fromEntries(send.q)).toMatchObject({ countryCode: '91', customerId: 'C-TEST', flowType: 'SMS', mobileNumber: '9811111111', otpLength: '6' });

    const wrong = await post('/v1/auth/otp/verify', { phone: '9811111111', code: '000000' });
    expect(wrong.body.error.code).toBe('otp_wrong');
    expect(calls.at(-1)!.q.get('verificationId')).toBe('VID1');

    const ok = await post('/v1/auth/otp/verify', { phone: '9811111111', code: '123456' });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(tokenCalls()).toBe(1); // the token is kept between calls
  });

  it('a code that expired there asks for a new one', async () => {
    await post('/v1/auth/otp/request', { phone: '9822222222' });
    onValidate = () => json({ responseCode: 705, message: 'VERIFICATION_EXPIRED', data: null }, 400);
    expect((await post('/v1/auth/otp/verify', { phone: '9822222222', code: '123456' })).body.error.code).toBe('otp_expired');
  });

  it('asking again while the last code is still live there says to wait', async () => {
    onSend = () => json({ responseCode: 506, message: 'REQUEST_ALREADY_EXISTS', data: null }, 400);
    const r = await post('/v1/auth/otp/request', { phone: '9833333333' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('otp_too_soon');
  });

  it('gets a new token when Message Central refuses the kept one', async () => {
    let refused = false;
    onSend = () => (refused ? sentOk('VID4') : ((refused = true), json({ message: 'Unauthorized' }, 401)));
    expect((await post('/v1/auth/otp/request', { phone: '9844444444' })).status).toBe(200);
    expect(tokenCalls()).toBe(1);
    expect(calls.filter((c) => c.path === '/verification/v3/send')).toHaveLength(2);
  });

  it('fails without showing a code when Message Central fails', async () => {
    onSend = () => json({ responseCode: 500, message: 'SERVER_ERROR', data: null }, 500);
    const r = await post('/v1/auth/otp/request', { phone: '9855555555' });
    expect(r.status).toBe(500);
    expect(r.body.devCode).toBeUndefined();
  });

  it('the store reviewer number never calls Message Central', async () => {
    expect((await post('/v1/auth/otp/request', { phone: '9876543210' })).status).toBe(200);
    expect((await post('/v1/auth/otp/verify', { phone: '9876543210', code: '246810' })).status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
