/**
 * Set the support numbers the app shows: the number customers call and the WhatsApp number.
 * "-" removes one. Uses DATABASE_URL like the other scripts.
 *
 *   npm run support:set -- "98140 12345" 9814012345
 *   npm run support:set -- "0172 5012345" -
 */
import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { getSettings, setSetting } from '../lib/settings.js';
import { parseCallNumber, parseWhatsappNumber } from '../lib/support-numbers.js';

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: npm run support:set -- <call number> <whatsapp mobile>   (- for none)');
  process.exit(1);
}
const phone = parseCallNumber(args[0]);
const whatsapp = parseWhatsappNumber(args[1]);
if (phone === null) console.error(`"${args[0]}" is not a number to call. Type 10 to 13 digits, like 98140 12345 or 0172 5012345, or - for none.`);
if (whatsapp === null) console.error(`"${args[1]}" is not a WhatsApp number. Type a 10-digit mobile, like 98140 12345, or - for none.`);
if (phone === null || whatsapp === null) process.exit(1);

const { db, close } = await openDb();
await setSetting(db, 'supportPhone', phone);
await setSetting(db, 'supportWhatsapp', whatsapp);
const s = await getSettings(db);
await close();
console.log(`Saved. Call: ${s.supportPhone || 'none'}. WhatsApp: ${s.supportWhatsapp || 'none'}.`);
console.log('The app shows them at once.');
if (!config.DATABASE_URL) console.log(`(No DATABASE_URL, so this went to the local database in ${config.PGLITE_DIR}, not the live server.)`);
