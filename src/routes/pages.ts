import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/client.js';
import { getSettings, type StoreSettings } from '../lib/settings.js';

/**
 * The public web pages the App Store and Play Store listings link to: the privacy policy, the
 * support page, and how to delete an account (Google Play asks for a web link as well as the in-app
 * button). Contact details come from the admin's settings (support phone, email, hours).
 */

/** The business behind the app, as the privacy policy names it (the app's Terms tab says the same). */
const BUSINESS = {
  name: 'ElectroDash',
  address: 'Plot No. 962, Sector 82, JLPL, Mohali, Punjab 140306',
  grievanceOfficer: 'Vivek Kumar',
};
/** Shown at the top of the privacy policy; change it whenever the policy changes. */
const POLICY_UPDATED = '29 October 2026';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ElectroDash</title>
<style>
  :root { --primary: #0B5FA5; --text: #1A2433; --muted: #5B6675; --line: #E3E8EF; --bg: #F5F7FA; --card: #FFFFFF; }
  @media (prefers-color-scheme: dark) { :root { --primary: #6FB2EE; --text: #E8EDF3; --muted: #A2AEBD; --line: #2A3442; --bg: #111720; --card: #18202B; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { background: var(--primary); color: #fff; padding: 18px 16px; }
  header a { color: #fff; text-decoration: none; font-weight: 800; font-size: 20px; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 28px; line-height: 1.25; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 28px 0 6px; }
  p, li { color: var(--text); }
  ul { padding-left: 20px; }
  .muted { color: var(--muted); font-size: 14px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin: 16px 0; }
  a { color: var(--primary); }
  footer { max-width: 760px; margin: 0 auto; padding: 0 16px 32px; }
</style>
</head>
<body>
<header><a href="/support">ElectroDash</a></header>
<main>
${body}
</main>
<footer class="muted"><a href="/privacy">Privacy policy</a> · <a href="/support">Support</a> · <a href="/delete-account">Delete account</a></footer>
</body>
</html>`;
}

/** "Email support@… · Call +91 … (Mon–Sat 9–7)", or a pointer to the in-app help when nothing is set. */
function contactHtml(s: StoreSettings) {
  const lines = [
    s.supportEmail && `Email: <a href="mailto:${esc(s.supportEmail)}">${esc(s.supportEmail)}</a>`,
    s.supportPhone && `Phone: <a href="tel:${esc(s.supportPhone.replace(/\s/g, ''))}">${esc(s.supportPhone)}</a>`,
    s.supportHoursText && `Hours: ${esc(s.supportHoursText)}`,
  ].filter(Boolean);
  return lines.length ? `<p>${lines.join('<br>')}</p>` : '<p>Use <strong>Account → Contact us</strong> in the app to send us a message.</p>';
}

function privacyHtml(s: StoreSettings) {
  return `
<h1>Privacy policy</h1>
<p class="muted">Last updated ${POLICY_UPDATED}</p>
<p>ElectroDash is an app for ordering electrical products for delivery. It is run by ${esc(BUSINESS.name)}, ${esc(BUSINESS.address)} (“we”, “us”). This policy explains what personal data the app collects, why, who sees it, and how you can delete it. It follows India’s Digital Personal Data Protection Act, 2023.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Your account:</strong> your mobile number (to log in with a one-time code), and the name and email address you add. If you log in with email, a password, stored only in scrambled (hashed) form.</li>
  <li><strong>Delivery addresses:</strong> the addresses you save: receiver name and phone, house and building, area, landmark, city, state, PIN code, and the map location of the address when you pick it on the map.</li>
  <li><strong>Your orders:</strong> what you bought, prices, payment method, coupons, delivery instructions, the tip for the delivery partner, a GSTIN and business name if you add one, and the receiver’s name and phone if you order for someone else.</li>
  <li><strong>Voice instructions:</strong> if you press and hold <em>Record</em> at checkout, the recording is stored with that order so the delivery partner can play it.</li>
  <li><strong>Ratings and reviews</strong> you write. Other customers see them with your first name and last initial.</li>
  <li><strong>Messages you send us</strong> through Contact us.</li>
  <li><strong>Location (only if you allow it):</strong> used while the app is open to fill in your address and check that we deliver there. We do not track your location in the background.</li>
  <li><strong>Microphone (only if you allow it):</strong> used only while you record a voice instruction or search by voice. Voice search is turned into text by your phone’s own speech service (from Apple or Google); we receive only the words.</li>
  <li><strong>Technical data:</strong> app version, device type, IP address and error logs, to keep the service working and secure.</li>
</ul>
<p>We do not use advertising trackers and we do not sell your personal data.</p>

<h2>How we use it</h2>
<ul>
  <li>To take, pack and deliver your orders, and to contact you about them.</li>
  <li>To answer your questions and handle returns and refunds.</li>
  <li>To prevent fraud and misuse, and to meet legal and tax duties (for example GST invoices).</li>
  <li>To send offers, only if you turn on offer alerts. You can turn them off any time in the app.</li>
</ul>

<h2>Who sees it</h2>
<ul>
  <li><strong>Our store staff and delivery partners</strong> see what they need for your order: name, phone, address, items and delivery instructions.</li>
  <li><strong>Service providers</strong> that run the app for us: cloud hosting and storage, the SMS service that sends login codes, and Expo (which delivers app updates). They may use the data only to provide their service to us.</li>
  <li><strong>Authorities</strong>, when the law requires it.</li>
</ul>

<h2>How long we keep it</h2>
<p>We keep your account data until you delete your account. Order and invoice records are kept for as long as GST and tax law requires, even after you delete your account, but without your name, phone number and street address.</p>

<h2>Delete your account</h2>
<p>In the app, go to <strong>Account → Delete account</strong> (<a href="/delete-account">how to delete your account</a>). This permanently removes your name, mobile number, email, saved addresses, cart, wishlist, notifications, ratings, voice instructions and login sessions. Past orders stay as sales records without your personal details. If an order is still on its way, you can delete your account once it is delivered or cancelled. You can also ask us to delete it using the contact details below.</p>

<h2>Your rights</h2>
<p>You can ask to see, correct or delete your personal data, withdraw your consent, or complain about how we handle it. Contact our Grievance Officer, ${esc(BUSINESS.grievanceOfficer)}, using the details below. If you are not satisfied with our reply, you can complain to the Data Protection Board of India.</p>

<h2>Security</h2>
<p>The app talks to our servers only over encrypted connections (HTTPS). Login codes and passwords are stored hashed, and only staff who need it can see order details.</p>

<h2>Children</h2>
<p>ElectroDash is for people aged 18 or over. We do not knowingly collect data from children.</p>

<h2>Changes</h2>
<p>If we change this policy we will update the date at the top, and tell you in the app about important changes.</p>

<h2>Contact us</h2>
<div class="card">${contactHtml(s)}<p class="muted">${esc(BUSINESS.name)}, ${esc(BUSINESS.address)}</p></div>
`;
}

function supportHtml(s: StoreSettings) {
  return `
<h1>Help &amp; support</h1>
<p>We’re here to help with orders, deliveries, returns and your account.</p>
<div class="card"><h2 style="margin-top:0">Contact us</h2>${contactHtml(s)}</div>

<h2>Track or cancel an order</h2>
<p>Open <strong>Account → Your orders</strong> and tap the order to see each step. You can cancel an order until it is packed.</p>

<h2>Returns and replacements</h2>
<p>Open the delivered order in <strong>Your orders</strong> and tap <strong>Return or replace items</strong> within the return window shown there (7 days for most items) if an item arrived damaged, defective, wrong or with parts missing. Send it back in its original box with all parts. We collect it from your address.</p>

<h2>Where we deliver</h2>
<p>We deliver from our store in Mohali, Punjab, to the PIN codes it serves. The app tells you before you order whether we deliver to your address.</p>

<h2>Delete your account</h2>
<p>In the app, go to <strong>Account → Delete account</strong>. Your personal details are removed permanently. <a href="/delete-account">More about deleting your account</a>.</p>
`;
}

/** Without the app: an email that opens ready to send, or the support phone. */
function deleteRequestHtml(s: StoreSettings) {
  const mail = s.supportEmail
    ? `<a href="mailto:${esc(s.supportEmail)}?subject=${encodeURIComponent('Delete my ElectroDash account')}&body=${encodeURIComponent('Please delete my ElectroDash account. My registered mobile number is: ')}">${esc(s.supportEmail)}</a>`
    : '';
  if (mail) return `<p>Email ${mail} from any email address, with the subject <strong>Delete my ElectroDash account</strong> and the mobile number you log in with.${s.supportPhone ? ` Or call ${esc(s.supportPhone)}.` : ''} To protect your account we may ask you to confirm with a code sent to that number.</p>`;
  return `<p>Write to us from the app’s <strong>Account → Contact us</strong> page, or use the contact details on our <a href="/support">support page</a>.</p>`;
}

function deleteAccountHtml(s: StoreSettings) {
  return `
<h1>Delete your ElectroDash account</h1>
<p>You can delete your ElectroDash account and personal data at any time.</p>

<div class="card">
<h2 style="margin-top:0">In the app</h2>
<ol>
  <li>Open ElectroDash and log in.</li>
  <li>Tap <strong>Account</strong>.</li>
  <li>Scroll down and tap <strong>Delete account</strong>.</li>
  <li>Tap <strong>Delete my account</strong>, then <strong>Delete</strong> to confirm.</li>
</ol>
<p class="muted">Your account is deleted straight away and you are logged out on every phone.</p>
</div>

<h2>Without the app</h2>
${deleteRequestHtml(s)}
<p>We delete the account within 30 days of your request and confirm by email.</p>

<h2>What is deleted</h2>
<ul>
  <li>Your name, mobile number, email and password</li>
  <li>Saved addresses</li>
  <li>Cart, wishlist and notifications</li>
  <li>Your ratings and reviews</li>
  <li>Voice instructions you recorded</li>
  <li>Your login sessions</li>
</ul>

<h2>What is kept</h2>
<p>Records of past orders (items, amounts, payment method, PIN code and any GSTIN), kept for as long as GST and tax law requires. Your name, phone number and street address are removed from them.</p>
<p>If an order is still on its way or a return is in progress, the account can be deleted once it is finished.</p>
<p>Read our <a href="/privacy">privacy policy</a>.</p>
`;
}

export async function pageRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page('Privacy policy', privacyHtml(await getSettings(db)))));
  app.get('/support', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page('Help & support', supportHtml(await getSettings(db)))));
  app.get('/delete-account', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(page('Delete your account', deleteAccountHtml(await getSettings(db)))),
  );
}
