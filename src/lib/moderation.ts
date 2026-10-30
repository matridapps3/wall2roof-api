/**
 * The filter Apple asks for in apps where customers post content (App Store guideline 1.2): reviews
 * with abusive words are refused before anyone sees them. English and common Hindi/Punjabi abuse in
 * Latin letters, matched as whole words (so "stopcock" or "Scunthorpe" pass), including simple
 * disguises like "sh1t" or "f@ck".
 */
const BLOCKED = [
  'fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'fuckers', 'motherfucker', 'fck', 'fuk',
  'shit', 'shitty', 'bullshit', 'bitch', 'bitches', 'bastard', 'asshole', 'arsehole', 'dick', 'dickhead',
  'cunt', 'slut', 'whore', 'pussy', 'cock', 'wanker', 'prick', 'retard', 'nigger', 'nigga', 'faggot',
  'madarchod', 'maderchod', 'behenchod', 'bhenchod', 'benchod', 'bhanchod', 'chutiya', 'chutiye', 'chutia',
  'gandu', 'gaandu', 'bhosdi', 'bhosdike', 'bhosadike', 'bhosdika', 'randi', 'harami', 'haramkhor',
  'lauda', 'lavda', 'lawda', 'loda', 'lund', 'chodu', 'jhaatu', 'jhatu', 'kutiya', 'kamine', 'kamina',
];

/**
 * Each word as a pattern where a vowel may also be written as a look-alike ("sh1t", "f@ck", "b!tch")
 * but not as another vowel (so "shut" stays allowed), and "s" as "$" or "5".
 */
function lookAlike(word: string) {
  return word.replace(/[aeiou]/g, (v) => `[${v}@*#!1|034]`).replace(/s/g, () => '[s$5]');
}

const PATTERN = new RegExp(`(?<![\\p{L}\\d])(?:${BLOCKED.map(lookAlike).join('|')})(?![\\p{L}\\d])`, 'iu');

export function hasBlockedWords(text: string): boolean {
  return PATTERN.test(text);
}
