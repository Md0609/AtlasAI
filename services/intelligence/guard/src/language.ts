/**
 * Layer 0 — the evaluability screen.
 *
 * Every rule in layers 2 and 3 is an English regex. That is correct and
 * deliberate: the PRD scopes the MVP to English ("Internationalization:
 * English at MVP; ES/DE/FR/PT at v1.1"; F-40 is a v1.1 feature; launch is
 * "EU only, English"). Translating the rule set here would be implementing
 * i18n, not hardening the Guard.
 *
 * The defect is narrower and worse: nothing ever CHECKED that precondition.
 * A model handed a Spanish question answers in Spanish, every English pattern
 * misses, and the Guard returns `approved: true` — recording a pass it never
 * actually performed. That is a compliance control failing OPEN, and §875
 * is unambiguous that a directive reaching a user is a P0 incident regardless
 * of the language it was written in.
 *
 * So this layer does not detect directives in other languages. It detects that
 * the text is not in the language the other layers can read, and refuses to
 * vouch for it. The caller then degrades to the deterministic template — the
 * same path already taken on refusal, numeral drift and guard rejection, so no
 * new failure mode is introduced, only an existing one correctly triggered.
 *
 * Fails closed by construction: if we cannot read it, we do not approve it.
 */
import type { GuardViolation } from '@atlas/contracts';
import type { LexicalInputSegment } from './lexical.js';

export const LANGUAGE_SCREEN_VERSION = 'lang.v1';

/**
 * Function words from the languages of the enabled jurisdictions (ES, DE, FR,
 * PT, IT). Three deliberate constraints keep false positives near zero:
 *
 *  1. Function words only — never nouns or verbs. Security names are the main
 *     source of foreign text in legitimate English output ("Telefónica",
 *     "Société Générale"), and proper nouns are not grammar.
 *  2. Three characters minimum. Short particles ("de", "la", "el", "y") occur
 *     constantly inside company names; "Telefónica de España y La Caixa" must
 *     not trip this.
 *  3. Nothing that is also an English word. Excluded for exactly that reason:
 *     "per", "con", "die", "man", "war", "hat", "den", "son", "plus", "sur"
 *     is borderline but kept out of an abundance of caution.
 */
const FOREIGN_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // Spanish
  'que', 'para', 'pero', 'como', 'porque', 'cuando', 'también', 'desde', 'hasta',
  'esto', 'eso', 'esta', 'está', 'están', 'tiene', 'tienes', 'ahora', 'mismo',
  'muy', 'todo', 'todos', 'sobre', 'entre', 'aunque', 'más', 'sus', 'tus',
  // German
  'und', 'das', 'der', 'nicht', 'aber', 'auch', 'sind', 'eine', 'einen', 'ihre',
  'sein', 'sich', 'oder', 'wenn', 'wird', 'werden', 'können', 'sollten', 'sehr', 'ist',
  // French
  'dans', 'pour', 'avec', 'mais', 'vous', 'votre', 'être', 'sont', 'cette',
  'aussi', 'faire', 'les', 'des', 'une', 'est', 'ont', 'nous',
  // Portuguese
  'não', 'você', 'também', 'está', 'são', 'deve', 'isso', 'muito', 'mais', 'seu', 'sua',
  // Italian
  'che', 'non', 'anche', 'questo', 'della', 'delle', 'sulla', 'sono',
]);

/**
 * The most frequent English function words. Their ABSENCE from a long enough
 * passage is the second signal: prose with no English grammar in it is not
 * English, whatever alphabet it happens to use.
 */
const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'the', 'of', 'and', 'to', 'in', 'is', 'it', 'you', 'your', 'that', 'for',
  'on', 'are', 'with', 'as', 'this', 'at', 'from', 'or', 'not', 'has', 'have',
  'was', 'were', 'been', 'but', 'they', 'their', 'what', 'when', 'which',
  'more', 'than', 'been', 'would', 'could', 'a', 'an', 'be', 'by', 'if', 'no',
]);

/** Two distinct foreign function words is already strong evidence. */
const FOREIGN_THRESHOLD = 2;
/** Below this many words, density is noise; only the foreign signal applies. */
const MIN_WORDS_FOR_DENSITY = 12;
/** Real English prose sits far above this; 10% is a floor, not a target. */
const MIN_ENGLISH_DENSITY = 0.1;

/** Unicode-aware word split — accented characters are letters, not separators. */
function words(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+/gu) ?? [];
}

/**
 * Screens the UNQUOTED text only. The user's own words — a thesis, a rule's
 * stated reason — may be in any language they like; that is their prose, not
 * Atlas's, and it is already masked from every other layer for the same
 * reason.
 */
export function languageScreen(segments: LexicalInputSegment[]): GuardViolation[] {
  const unquoted = segments
    .filter((s) => !s.quoted)
    .map((s) => s.text)
    .join(' ');
  const w = words(unquoted);
  if (w.length === 0) return [];

  const foreign = new Set(w.filter((t) => FOREIGN_FUNCTION_WORDS.has(t)));
  if (foreign.size >= FOREIGN_THRESHOLD) {
    return [
      {
        layer: 'lexical',
        code: 'lang.not_evaluable',
        detail:
          `text appears not to be English (${[...foreign].slice(0, 4).join(', ')}); ` +
          `the rule set is English-only at MVP, so this output cannot be screened and is not approved`,
      },
    ];
  }

  if (w.length >= MIN_WORDS_FOR_DENSITY) {
    const english = w.filter((t) => ENGLISH_FUNCTION_WORDS.has(t)).length;
    if (english / w.length < MIN_ENGLISH_DENSITY) {
      return [
        {
          layer: 'lexical',
          code: 'lang.not_evaluable',
          detail:
            `text of ${w.length} words contains almost no English function words ` +
            `(${english}); it cannot be screened by an English-only rule set and is not approved`,
        },
      ];
    }
  }

  return [];
}
