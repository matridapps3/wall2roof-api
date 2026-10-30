import { config } from '../config.js';
import { checkMessageCentralOtp, sendMessageCentralOtp, type OtpCheck } from './message-central.js';

export type OtpDelivery = {
  sent: true;
  devCode?: string;
  /** Message Central made and sent its own code instead of ours; checking it needs this id. */
  verificationId?: string;
  /** How long the provider makes the customer wait before another code. */
  resendInSec?: number;
};

/** Whether codes are shown in the app instead of sent by SMS: OTP_PROVIDER console/test, or the testLogin setting. */
export function isTestLogin(testLoginSetting: boolean): boolean {
  return (config.OTP_PROVIDER !== 'msg91' && config.OTP_PROVIDER !== 'messagecentral') || testLoginSetting;
}

/**
 * Sends the OTP. In test login (see isTestLogin) no SMS is sent: the code is logged and
 * returned to the app, which fills it in.
 */
export async function sendOtp(phone: string, code: string, log: { info: (msg: string) => void }, testLoginSetting = false): Promise<OtpDelivery> {
  if (isTestLogin(testLoginSetting)) {
    log.info(`[test OTP] ${phone} → ${code}`);
    return { sent: true, devCode: code };
  }
  if (config.OTP_PROVIDER === 'messagecentral') return { sent: true, ...(await sendMessageCentralOtp(phone)) };
  if (!config.MSG91_AUTH_KEY || !config.MSG91_TEMPLATE_ID) {
    throw new Error('MSG91 is not configured (MSG91_AUTH_KEY, MSG91_TEMPLATE_ID).');
  }
  const res = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey: config.MSG91_AUTH_KEY },
    body: JSON.stringify({ template_id: config.MSG91_TEMPLATE_ID, mobile: `91${phone}`, otp: code }),
  });
  if (!res.ok) throw new Error(`SMS provider error (${res.status})`);
  return { sent: true };
}

/** Checks a code the provider made itself (see OtpDelivery.verificationId). */
export function checkSentOtp(phone: string, verificationId: string, code: string): Promise<OtpCheck> {
  return checkMessageCentralOtp(phone, verificationId, code);
}
