/**
 * Point the app's "New version available — Download" banner (Android only) at the newest APK.
 * Phones on an older version see it, and so do phones on the same version whose APK lacks the
 * newest one's native parts (APKs before build 8 have no order notifications). "-" removes it.
 * Uses DATABASE_URL like the other scripts.
 *
 *   npm run app:latest -- 1.1.0 https://expo.dev/artifacts/eas/....apk
 *   npm run app:latest -- -
 */
import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { getSettings, setSetting } from '../lib/settings.js';

const args = process.argv.slice(2);
const clear = args.length === 1 && args[0] === '-';
const [version, url] = args;
if (!clear && (args.length !== 2 || !/^\d+(\.\d+)*$/.test(version) || !/^https:\/\/\S+$/.test(url))) {
  console.error('Usage: npm run app:latest -- <version like 1.1.0> <https link to the APK>   (or - to remove)');
  process.exit(1);
}

const { db, close } = await openDb();
await setSetting(db, 'latestAppVersion', clear ? '' : version);
await setSetting(db, 'latestAppUrl', clear ? '' : url);
const s = await getSettings(db);
await close();
console.log(s.latestAppVersion ? `Saved. Latest APK: ${s.latestAppVersion}, ${s.latestAppUrl}` : 'Saved. No latest APK: the banner is off.');
console.log('Phones see it the next time the app loads its settings (a few minutes, or on restart).');
if (!config.DATABASE_URL) console.log(`(No DATABASE_URL, so this went to the local database in ${config.PGLITE_DIR}, not the live server.)`);
