import { normalizeForMatch } from "./render";

export type RestrictedCategory =
  | "sexuality"
  | "health"
  | "finances"
  | "family"
  | "location"
  | "schedule"
  | "business_terms"
  | "beliefs"
  | "legal";

export type PersonalHit =
  | { tier: "restricted"; category: RestrictedCategory }
  | { tier: "candid"; category: "candid" | "about_others" };

// Restricted tiers favor recall: refusing a harmless fact is acceptable, leaking a personal one is not.
// Most rules need a first-person frame ("my …", "I …") so ordinary work text with the same words passes.
// Rules run in order; the first match wins. Text is matched after NFKC + format-character stripping.

const HEALTH_TERMS =
  "doctor|physician|cardiolog\\w*|oncolog\\w*|dermatolog\\w*|neurolog\\w*|psychiatr\\w*|psycholog\\w*|therap(?:y|ist|ists)|dentist|orthodont\\w*|surgery|surgeon|diagnos\\w+|medications?|prescriptions?|antidepressants?|migraines?|blood pressure|cholesterol|anxiety|depression|allerg\\w+|diabet\\w+|asthma|back pain|injur(?:y|ies)|chemo\\w*|pregnan\\w+|physio\\w*|mental health|sick leave|eating disorder|panic attacks?";

const FINANCE_TERMS =
  "401\\(?k\\)?|mortgage|savings|salary|debts?|credit (?:score|card)s?|net worth|tax(?:es| returns?)|retirement|pension|investments?|portfolio|bank account|brokerage|loans?|stocks?|crypto\\w*|income|paycheck|bonus|rent";

const FAMILY_TERMS =
  "kids?|child(?:ren)?|sons?|daughters?|wife|husband|spouse|mother|father|mom|mum|dad|parents|brothers?|sisters?|siblings?|baby|grand(?:mother|father|parents|ma|pa)|girlfriend|boyfriend|fianc\\w+|family|wedding|in-laws?";

const LOCATION_TERMS =
  "home|house|apartment|flat|neighbou?rhood|street|hometown|zip code|postcode|(?:mailing|postal|street|current|new) address";

const PRIVATE_LIFE =
  "(?:going through (?:a |an )?(?:divorce|separation|breakup|chemo\\w*)|getting (?:a )?divorce[d]?|(?:is|was|got|been|recently|just) divorced|pregnant|expecting (?:a )?(?:baby|child)|(?:has|had|have|got|diagnosed with) (?:cancer|diabetes|depression|anxiety|hiv|an? (?:illness|disease|eating disorder|addiction))|in rehab|in therapy|on (?:medication|antidepressants|sick leave|medical leave)|(?:struggling|battling|dealing) with (?:depression|addiction|anxiety|alcoholism|cancer|illness)|having an affair|cheating on|(?:filed|filing) for (?:bankruptcy|divorce)|diagnosed with \\w+)";

const NAME = "(?!(?:The|This|That|It|There|We|They|He|She|I|If|When|My|Our)\\b)[A-Z][a-z]+";
const LEAD = "(?:(?:is|was|has|had|are|just|recently|currently|now|been|got|have|will be)\\s+){0,3}";
const ROLE_NOUN =
  "(?:client|customer|founders?|ceo|cto|cfo|boss|manager|colleagues?|coworkers?|co-workers?|vendor|contractor|investors?|management|leadership|owner|team lead)";
const PERSON_ROLE = `(?:the|my|our)\\s+${ROLE_NOUN}(?:'s)?`;
const PERSON_ANY = `(?:their|his|her|${PERSON_ROLE}|(?:he|she|they))`;
const NEG =
  "(?:weak|bad|terrible|awful|stupid|dumb|incompetent|inept|useless|doomed|hopeless|lazy|dishonest|unprofessional|mediocre|toxic|clueless|shady|sloppy|idiotic|unreliable|disorganized|amateurish|pathetic|a joke|garbage|greedy|arrogant|manipulative|delusional|unethical|corrupt|rude|incapable)";

const RESTRICTED_RULES: [RestrictedCategory, RegExp][] = [
  [
    "sexuality",
    /\b(?:sexual orientation|sex life|my gender (?:identity|transition)|(?:i|i'm|i am)\b[^.!?\n]{0,25}\b(?:gay|lesbian|bisexual|transgender|nonbinary|non-binary|asexual|pansexual)|i came out)\b/i,
  ],
  ["health", new RegExp(`\\b(?:my|i)\\b[^.!?\\n]{0,40}?\\b(?:${HEALTH_TERMS})\\b`, "i")],
  ["legal", /\bmy\s+(?:\w+\s+){0,2}(?:lawsuit|lawyer|attorney|solicitor|visa|green card|immigration|citizenship|asylum|court (?:date|case|hearing)|custody|divorce|restraining order|criminal record|arrest|probation|parole|legal (?:case|troubles?|issues?))\b/i],
  ["legal", /\bi(?:'m| am| was| got| have been| had been)\s+(?:being\s+)?(?:suing|sued|arrested|charged with|detained|deported|convicted)\b/i],
  ["finances", new RegExp(`\\b(?:my|our)\\s+(?:[\\w$]+\\s+){0,2}(?:${FINANCE_TERMS})\\b`, "i")],
  ["finances", /\b(?:my|our)\s+(?:\w+\s+){0,2}(?:IRA|Roth)\b/],
  ["finances", /\bi\s+(?:owe|earn|earned|inherited)\b|\bi(?:'m| am)\s+(?:in debt|broke)\b/i],
  ["family", new RegExp(`\\bmy\\s+(?:\\w+\\s+)?(?:${FAMILY_TERMS})\\b`, "i")],
  ["family", /\b(?:i'?m|i am)\s+(?:getting\s+(?:married|divorced)|engaged|expecting)\b|\bour baby\b/i],
  ["location", new RegExp(`\\bmy\\s+(?:\\w+\\s+){0,2}(?:${LOCATION_TERMS})\\b(?!\\s*(?:dir|directory|folder|network|server|lab|router|assistant|page|screen|config|office|machine|setup|nas|wifi|wi-fi))`, "i")],
  ["location", /\bi\s+live\s+(?:in|on|at|near|with|next|by|just)\b/i],
  ["location", /\b(?:i|we)(?:'ve| have)?\s+(?:moved|moving|relocated|relocating)\s+(?:in)?to\s+(?:a|an|the|my|our)\s+(?:\w+\s+)?(?:house|apartment|flat|home|town|city|suburb|neighbou?rhood|condo)\b/i],
  ["schedule", /\bi(?:'ll| will|'m| am)\s+(?:be\s+)?(?:away|unavailable|offline|out of (?:the )?office|on (?:vacation|holiday|leave|pto)|out (?:from|until|on|next|this|all|for)|off (?:on|from|until|next|this|for)|(?:travell?ing|flying)\s+(?:to|on|next|from))\b/i],
  ["schedule", /\bmy\s+(?:\w+\s+){0,2}(?:vacation|holidays?|days? off|day off|trip|flight|travel plans|routine|gym|bedtime|commute|sabbatical|time off|pto)\b/i],
  ["schedule", /\bi\s+(?:wake up|go to bed|go to the gym)\b/i],
  ["business_terms", /\bmy\s+(?:\w+\s+){0,2}(?:rates?\b(?!\s+limit)|fees?\b|retainer|invoices?\b|contract(?!s?\s+tests?)\b|pricing|billing rate)/i],
  ["business_terms", /\b(?:i|i'm|we)\s+(?:charge|charged|invoice|invoiced|invoicing|bill|billed)\b/i],
  ["business_terms", /\b(?:owes?|owed|pays?|paying|paid)\s+me\b|\bi(?:'m| am)\s+owed\b/i],
  ["business_terms", /\b(?:i|i'm|we|we're|my)\b[^.!?\n]{0,25}\bnegotiat\w*\s+(?:\w+\s+){0,2}(?:rates?|fees?|contract|terms|retainer|raise|price|pricing|deal|salary)\b/i],
  ["business_terms", /\b(?:payment|invoice|billing|fee) disputes?\b/i],
  ["business_terms", /\bi\b[^.!?\n]{0,30}\$\s?\d[\d,.]*k?\s*(?:\/|per\s+)(?:h|hr|hour|day|week|month)\b/i],
  ["beliefs", /\bi\s+(?:vote|voted|pray)\b|\bi(?:'ll| will| plan to)\s+vote\b/i],
  ["beliefs", /\bmy\s+(?:\w+\s+){0,2}(?:religio\w*|faith|political|politics|party affiliation|church|prayers?)\b/i],
  ["beliefs", /\bi(?:'m| am)\s+(?:a\s+)?(?:registered\s+)?(?:republican|democrat|conservative|liberal|socialist|communist|libertarian|christian|muslim|jewish|hindu|buddhist|atheist|catholic|evangelical|sikh|agnostic)\b/i],
  ["beliefs", /\bi\s+(?:go to|attend)\s+(?:the\s+)?(?:church|mosque|synagogue|temple|mass)\b/i],
];

// Candid / about-others rules favor precision: a false hit in a client scope can't be overridden.
// They need a first-person judgment frame, or a named person (or role) next to a private-life or pay term.
// A person's role, ownership and work preferences are work facts and never match.
const CANDID_RULES: [PersonalHit & { tier: "candid" }, RegExp][] = [
  [
    { tier: "candid", category: "candid" },
    new RegExp(`\\bi\\s+(?:think|feel|find|believe|reckon|suspect)\\b[^.!?\\n]{0,40}?\\b${PERSON_ANY}\\b[^.!?\\n]{0,40}?\\b(?:(?:is|are|was|were|seems?|looks?)\\s+)?(?:\\w+\\s+){0,2}?${NEG}\\b`, "i"),
  ],
  [
    { tier: "candid", category: "candid" },
    new RegExp(`\\bi\\s+(?:(?:can't|cannot|can not|don't|do not)\\s+(?:stand|trust|respect)|despise|loathe|distrust|resent|dislike|hate)\\s+(?:working with\\s+)?${PERSON_ROLE}`, "i"),
  ],
  [{ tier: "candid", category: "about_others" }, new RegExp(`\\b${NAME}(?:'s)?\\s+${LEAD}${PRIVATE_LIFE}`)],
  [{ tier: "candid", category: "about_others" }, new RegExp(`\\b${NAME}'s\\s+(?:salary|pay|bonus|compensation|income)\\b`)],
  [{ tier: "candid", category: "about_others" }, new RegExp(`\\b${NAME}\\s+(?:earns\\s+(?:about |around )?[$£€]?\\s?\\d|(?:makes|is paid|gets paid)\\s+(?:about |around )?[$£€]\\s?\\d)`)],
  [
    { tier: "candid", category: "about_others" },
    new RegExp(`\\b(?:my|our|the)\\s+(?:colleague|coworker|co-worker|manager|boss|client|contact|friend|teammate|cto|ceo|cfo|founder|neighbou?r|landlord)(?:'s\\s+(?:salary|pay|bonus|compensation|income)\\b|\\s+${LEAD}${PRIVATE_LIFE})`, "i"),
  ],
];

export function scanPersonal(text: string): PersonalHit | null {
  const t = normalizeForMatch(text).replace(/[‘’ʼ]/g, "'");
  for (const [category, re] of RESTRICTED_RULES) if (re.test(t)) return { tier: "restricted", category };
  for (const [hit, re] of CANDID_RULES) if (re.test(t)) return hit;
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The scope name of the first other client the text names (scope name or owner login, whole word, case-insensitive). */
export function scanCrossClient(text: string, others: { scope: string; owner: string }[]): string | null {
  const t = normalizeForMatch(text);
  for (const { scope, owner } of others) {
    for (const name of [scope, owner]) {
      if (name && new RegExp(`(?<!\\w)${escapeRe(name)}(?!\\w)`, "i").test(t)) return scope;
    }
  }
  return null;
}
