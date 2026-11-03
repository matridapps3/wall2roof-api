import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { setSetting } from '../src/lib/settings.js';
import { parseCallNumber, parseWhatsappNumber } from '../src/lib/support-numbers.js';

let h: DbHandle;
let app: FastifyInstance;

const support = async () => (await app.inject({ method: 'GET', url: '/v1/config' })).json().support;

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('support numbers in /v1/config', () => {
  it('has no WhatsApp number until one is saved', async () => {
    expect(await support()).toEqual({ phone: '', email: '', hours: '', whatsapp: '' });
  });

  it('returns the saved call and WhatsApp numbers', async () => {
    await setSetting(h.db, 'supportPhone', '0172 5012345');
    await setSetting(h.db, 'supportWhatsapp', '9814012345');
    expect(await support()).toMatchObject({ phone: '0172 5012345', whatsapp: '9814012345' });
    await setSetting(h.db, 'supportWhatsapp', '');
    expect((await support()).whatsapp).toBe('');
  });
});

describe('npm run support:set checks', () => {
  it('keeps a call number as typed: a mobile or a landline with its STD code', () => {
    expect(parseCallNumber('98140 12345')).toBe('98140 12345');
    expect(parseCallNumber('  0172   5012345 ')).toBe('0172 5012345');
    expect(parseCallNumber('+91 98140-12345')).toBe('+91 98140-12345');
    expect(parseCallNumber('1800-000-0000')).toBe('1800-000-0000');
    expect(parseCallNumber('+91 172 501 2345 0')).toBe('+91 172 501 2345 0'); // 13 digits
  });

  it('turns "-" into no number', () => {
    expect(parseCallNumber('-')).toBe('');
    expect(parseCallNumber(' - ')).toBe('');
    expect(parseWhatsappNumber('-')).toBe('');
  });

  it('refuses call numbers that are too short, too long or not numbers', () => {
    for (const bad of ['', ' ', '--', '12345', '981401234', '91 98140 12345 67', '98140x12345', '(0172) 5012345', 'none', '98140+12345', '++9814012345', '9814012345-', '-9814012345']) {
      expect(parseCallNumber(bad), bad).toBeNull();
    }
  });

  it('saves a WhatsApp number as its 10 digits', () => {
    expect(parseWhatsappNumber('9814012345')).toBe('9814012345');
    expect(parseWhatsappNumber('98140 12345')).toBe('9814012345');
    expect(parseWhatsappNumber('+91 98140-12345')).toBe('9814012345');
    expect(parseWhatsappNumber('098140 12345')).toBe('9814012345');
  });

  it('refuses a WhatsApp number that is not an Indian mobile', () => {
    for (const bad of ['', '--', '0172 5012345', '5814012345', '981401234', '98140123456', '98140x12345', 'none']) {
      expect(parseWhatsappNumber(bad), bad).toBeNull();
    }
  });
});
