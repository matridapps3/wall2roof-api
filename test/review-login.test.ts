import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Real SMS mode, but no MSG91 keys: any attempt to send an SMS fails, so the reviewer's number must not try.
vi.hoisted(() => {
  process.env.OTP_PROVIDER = 'msg91';
  process.env.REVIEW_PHONE = '9876543210';
  process.env.REVIEW_OTP = '246810';
});

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';

let h: DbHandle;
let app: FastifyInstance;

async function post(url: string, body: unknown) {
  const res = await app.inject({ method: 'POST', url, payload: body as object });
  return { status: res.statusCode, body: res.json() as any };
}

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('store reviewer login', () => {
  it('logs the reviewer number in with the fixed code, without an SMS and without showing the code', async () => {
    const sent = await post('/v1/auth/otp/request', { phone: '+91 98765 43210' });
    expect(sent.status).toBe(200);
    expect(sent.body.devCode).toBeUndefined();
    expect((await post('/v1/auth/otp/verify', { phone: '9876543210', code: '111111' })).body.error.code).toBe('otp_wrong');
    const ok = await post('/v1/auth/otp/verify', { phone: '9876543210', code: '246810' });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it('other numbers still go through SMS (here: no MSG91 keys, so it fails instead of showing a code)', async () => {
    const r = await post('/v1/auth/otp/request', { phone: '9812345678' });
    expect(r.status).toBe(500);
    expect(r.body.devCode).toBeUndefined();
  });
});
