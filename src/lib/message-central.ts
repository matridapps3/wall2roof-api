import { config } from '../config.js';
import { HttpError } from '../http.js';

/**
 * Message Central VerifyNow (cpaas.messagecentral.com): login codes by SMS in India without our own
 * DLT registration (it sends from its own registered sender). It makes the code and checks it itself,
 * so we keep only its verificationId. 30 paise per delivered SMS (Oct 2026), billed in USD.
 */
const BASE = 'https://cpaas.messagecentral.com';

type Reply = {
  responseCode?: number | string;
  message?: string;
  data?: { verificationId?: string | number; timeout?: string | number; verificationStatus?: string; responseCode?: string | number } | null;
};

let token: { value: string; expiresAt: number } | null = null;

/** When a token runs out: its JWT `exp` less a minute, or an hour when it doesn't say. */
function expiryOf(jwt: string): number {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    if (typeof exp === 'number') return exp * 1000 - 60_000;
  } catch {
    // not a readable JWT
  }
  return Date.now() + 3_600_000;
}

async function authToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return token.value;
  const { MESSAGECENTRAL_CUSTOMER_ID: customerId, MESSAGECENTRAL_PASSWORD: password } = config;
  if (!customerId || !password) {
    throw new Error('Message Central is not configured (MESSAGECENTRAL_CUSTOMER_ID, MESSAGECENTRAL_PASSWORD).');
  }
  const q = new URLSearchParams({ customerId, key: Buffer.from(password).toString('base64'), scope: 'NEW', country: '91' });
  const res = await fetch(`${BASE}/auth/v1/authentication/token?${q}`, { headers: { accept: '*/*' } });
  const body = (await res.json().catch(() => ({}))) as { token?: string };
  if (!res.ok || !body.token) throw new Error(`Message Central login failed (${res.status})`);
  token = { value: body.token, expiresAt: expiryOf(body.token) };
  return token.value;
}

/** One API call; once more with a new token when Message Central refuses the one we kept. */
async function call(method: 'GET' | 'POST', path: string, params: Record<string, string>) {
  for (let retried = false; ; retried = true) {
    const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { method, headers: { authToken: await authToken() } });
    if ((res.status === 401 || res.status === 403) && !retried) {
      token = null;
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as Reply;
    return { status: res.status, body, code: Number(body.data?.responseCode ?? body.responseCode) };
  }
}

export async function sendMessageCentralOtp(phone: string): Promise<{ verificationId: string; resendInSec?: number }> {
  const { status, body, code } = await call('POST', '/verification/v3/send', {
    countryCode: '91',
    customerId: config.MESSAGECENTRAL_CUSTOMER_ID!,
    flowType: 'SMS',
    mobileNumber: phone,
    otpLength: '6',
  });
  // 506: the last code is still live there (it makes us wait about a minute between codes)
  if (code === 506) throw new HttpError(429, 'otp_too_soon', 'Please wait a minute before requesting a new code.');
  if (code === 800) throw new HttpError(429, 'otp_limit', 'Too many codes requested. Try again in an hour.');
  const id = body.data?.verificationId;
  if (code !== 200 || id == null) throw new Error(`Message Central couldn't send the code (${status}, ${code} ${body.message ?? ''})`);
  const wait = Number(body.data?.timeout);
  return { verificationId: String(id), ...(wait > 0 ? { resendInSec: Math.ceil(wait) } : {}) };
}

export type OtpCheck = 'ok' | 'wrong' | 'expired' | 'locked';

export async function checkMessageCentralOtp(phone: string, verificationId: string, otp: string): Promise<OtpCheck> {
  const { status, body, code } = await call('GET', '/verification/v3/validateOtp', {
    countryCode: '91',
    customerId: config.MESSAGECENTRAL_CUSTOMER_ID!,
    flowType: 'SMS',
    mobileNumber: phone,
    verificationId,
    code: otp,
  });
  if (code === 200) return body.data?.verificationStatus === 'VERIFICATION_COMPLETED' ? 'ok' : 'wrong';
  if (code === 702 || code === 700) return 'wrong';
  if (code === 705 || code === 703 || code === 505) return 'expired';
  if (code === 800) return 'locked';
  throw new Error(`Message Central couldn't check the code (${status}, ${code} ${body.message ?? ''})`);
}
