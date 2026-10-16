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
  "doctor|physician|cardiolog\\w*|oncolog\\w*|dermatolog\\w*|neurolog\\w*|psychiatr\\w*|psycholog\\w*|therap(?:y|ist|ists)|dentist|orthodont\\w*|surgery|surgeon|diagnosed with|diagnosis|cancer|tumou?rs?|hospital\\w*|illness|diseases?|sick|adhd|autis\\w*|medications?|prescriptions?|antidepressants?|migraines?|blood pressure|cholesterol|anxiety|depression|allerg\\w+|diabet\\w+|asthma|back pain|injur(?:y|ies)|chemo\\w*|pregnan\\w+|physio\\w*|mental health|sick leave|eating disorder|panic attacks?";

// "tech debt" and "our crypto module" are engineering vocabulary; "crypto" alone (or the currency) is money.
const FINANCE_TERMS =
  "401\\(?k\\)?|mortgage|savings|salary|(?<!\\b(?:tech|technical|code|design|architectural)\\s)debts?|credit (?:score|card)s?|net worth|tax(?:es| returns?)|retirement|pension|investments?|portfolio|bank account|brokerage|loans?|stocks?|crypto(?:currency|currencies)?\\b(?!\\s+(?:module|modules|library|lib|libs|helpers?|keys?|signing|code|utils?|package|primitives?|api|service|layer|functions?))|bitcoin|income|paycheck|bonus|rent";
// "our" is usually the team or the client in work text ("our loans service"), so it only frames household money.
const HOUSEHOLD_FINANCE_TERMS = "401\\(?k\\)?|mortgage|savings|tax returns?|bank account|household (?:budget|income|bills)|family budget|rent(?! (?:service|api|table|module|endpoint))";

const FAMILY_TERMS =
  "kids?|child(?:ren)?|sons?|daughters?|wife|husband|spouse|mother|father|mom|mum|dad|parents|brothers?|sisters?|siblings?|baby|grand(?:mother|father|parents|ma|pa)|girlfriend|boyfriend|fianc\\w+|family|wedding|in-laws?";

const LOCATION_TERMS =
  "home|house|apartment|flat|neighbou?rhood|street|hometown|zip code|postcode|(?:mailing|postal|street|current|new) address";

const PRIVATE_LIFE =
  "(?:going through (?:a |an )?(?:divorce|separation|breakup|chemo\\w*)|getting (?:a )?divorce[d]?|(?:is|was|got|been|recently|just) divorced|pregnant|expecting (?:a )?(?:baby|child)|(?:has|had|have|got|diagnosed with) (?:cancer|diabetes|depression|anxiety|hiv|an? (?:illness|disease|eating disorder|addiction))|in rehab|in therapy|on (?:medication|antidepressants|sick leave|medical leave)|(?:struggling|battling|dealing) with (?:depression|addiction|anxiety|alcoholism|cancer|illness)|having an affair|cheating on|(?:filed|filing) for (?:bankruptcy|divorce)|diagnosed with \\w+)";

// A single word that is not a function word, determiner, pronoun or common work noun. Matched case-insensitively
// (not everyone capitalizes names), so the stoplist is what keeps "the server is ..." and "it earns ..." out.
const NOT_A_NAME =
  "the|a|an|this|that|these|those|our|their|my|your|his|her|its|i|we|you|it|they|he|she|me|us|them|who|which|what|there|here|and|or|but|so|if|when|then|also|still|not|never|just|now|recently|currently|is|was|are|were|be|been|being|has|had|have|do|does|did|will|would|can|could|should|may|might|to|of|in|on|for|with|by|from|as|at|about|after|before|while|because|since|than|very|more|most|all|some|any|each|every|no|one|two|new|old|other|another|such|only|even|both|either|many|much|few|own|same|server|servers|service|services|api|apis|app|apps|process|processes|job|jobs|team|teams|system|systems|module|modules|function|functions|client|clients|company|project|org|repo|database|db|worker|workers|queue|cache|pipeline|build|test|tests|code|data|user|users|customer|customers|vendor|contractor|investor|manager|boss|owner|management|leadership|colleague|coworker|ceo|cto|cfo|founder|founders|friend|contact|neighbor|neighbour|landlord";
const NAME = `(?!(?:${NOT_A_NAME})\\b)[a-z]{2,}`;

// Destinations after "moved to" / "live in" that are tools or things, not places.
const DEST_TECH =
  "postgres|postgresql|mysql|sqlite|kubernetes|k8s|docker|aws|gcp|azure|python|rust|go|golang|typescript|javascript|react|node|nodejs|java|kotlin|swift|terraform|github|gitlab|v\\d|version|monorepo|microservices|redis|kafka|vite|webpack|bun|deno|pnpm|npm|yarn|cloudflare|vercel|ruby|rails|django|flask|php|laravel|vue|angular|svelte|next|nextjs|linux|ubuntu|macos|windows|vitest|jest|pytest|jenkins|circleci|helm|ansible|mongodb|dynamodb|elasticsearch|oracle|snowflake|bigquery|graphql|grpc|rest|s3|ec2|lambda|serverless|cloud|prod|production|staging|main|master|trunk|git|ci|cd|oauth|sso|tls|sql|nosql|json|yaml|toml|typescript|ts|js|py|cpp|dotnet|tailwind";
const DEST_ARTICLE = "a|an|the|new|my|our|this|that|one|another|each|every|some|any";
const LEAD = "(?:(?:is|was|has|had|are|just|recently|currently|now|been|got|have|will be)\\s+){0,3}";
const ROLE_NOUN =
  "(?:client|customer|founders?|ceo|cto|cfo|boss|manager|colleagues?|coworkers?|co-workers?|vendor|contractor|investors?|management|leadership|owner|team lead)";
const PERSON_ROLE = `(?:the|my|our)\\s+${ROLE_NOUN}(?:'s)?`;
const PERSON_ANY = `(?:their|his|her|${PERSON_ROLE}|(?:he|she|they))`;
const NEG =
  "(?:weak|bad|terrible|awful|stupid|dumb|incompetent|inept|useless|doomed|hopeless|lazy|dishonest|unprofessional|mediocre|toxic|clueless|shady|sloppy|idiotic|unreliable|disorganized|amateurish|pathetic|a joke|garbage|greedy|arrogant|manipulative|delusional|unethical|corrupt|rude|incapable)";

// "<Place>, <Region>" (US state, Canadian province, country, or a postal code) is a place even when the first
// word is also a tool name ("Postgres, Tennessee"). Names match case-insensitively; two-letter codes must be capitalized.
const REGION_NAMES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|usa|united states|uk|united kingdom|england|scotland|wales|ireland|canada|mexico|brazil|argentina|chile|colombia|peru|france|germany|spain|portugal|italy|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|czechia|czech republic|greece|turkey|israel|egypt|south africa|nigeria|kenya|morocco|india|pakistan|china|japan|south korea|korea|vietnam|thailand|indonesia|philippines|singapore|malaysia|australia|new zealand|uae|russia|ukraine";
const REGION_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|ON|QC|BC|AB|MB|SK|NS|NB|NL|PE";
const PLACE_WORDS = "[a-z][a-z.'-]*(?:\\s+[a-z][a-z.'-]*)?";
/** Two rules (names, then capitalized codes) for `prefix` followed by "<Place>, <Region>". */
const withPlace = (prefix: string, category: RestrictedCategory): [RestrictedCategory, RegExp][] => [
  [category, new RegExp(`${prefix}${PLACE_WORDS},\\s*(?:${REGION_NAMES})\\b`, "i")],
  [category, new RegExp(`${prefix}${PLACE_WORDS.replace(/a-z/g, "A-Za-z")},\\s*(?:${REGION_CODES})\\b`)],
];
const PLACE_PREP = "\\b(?:in|to|from|near|at|around|outside|by)\\s+";
const FIRST_PERSON = "\\b(?:i|we|my)\\b[^.!?\\n]{0,40}?\\b";
const PLACE_RULES: [RestrictedCategory, RegExp][] = [
  ...withPlace(`${FIRST_PERSON}(?:mov(?:e|ed|ing)|relocat\\w+|live[sd]?|living|stay\\w*|grew|born|based|commut\\w+|home|house|family|drive|driving|visit\\w*)\\b[^.!?\\n]{0,30}?${PLACE_PREP}`, "location"),
  ...withPlace(`${FIRST_PERSON}(?:travel\\w*|trip|fly|flying|flew|flight|head\\w*)\\b[^.!?\\n]{0,30}?${PLACE_PREP}`, "schedule"),
  ...withPlace("\\b(?:down the road from|a short drive from|(?:minutes|miles|hours) (?:away )?from)\\s+", "location"),
];

const RESTRICTED_RULES: [RestrictedCategory, RegExp][] = [
  ...PLACE_RULES,
  [
    "sexuality",
    /\b(?:sexual orientation|sex life|my gender (?:identity|transition)|(?:i|i'm|i am)\b[^.!?\n]{0,25}\b(?:gay|lesbian|bisexual|transgender|nonbinary|non-binary|asexual|pansexual)|i came out)\b/i,
  ],
  ["health", new RegExp(`\\b(?:my|i)\\b(?!/)[^.!?\\n]{0,40}?\\b(?:${HEALTH_TERMS})\\b(?![-/])`, "i")],
  ["legal", /\bmy\s+(?:\w+\s+){0,2}(?:lawsuit|lawyer|attorney|solicitor|visa|green card|immigration|citizenship|asylum|court (?:date|case|hearing)|custody|divorce|restraining order|criminal record|arrest|probation|parole|legal (?:case|troubles?|issues?))\b/i],
  ["legal", /\bi(?:'m| am| was| got| have been| had been)\s+(?:being\s+)?(?:suing|sued|arrested|charged with|detained|deported|convicted)\b/i],
  ["finances", new RegExp(`\\bmy\\s+(?:[\\w$]+\\s+){0,2}(?:${FINANCE_TERMS})\\b`, "i")],
  ["finances", new RegExp(`\\bour\\s+(?:[\\w$]+\\s+){0,2}(?:${HOUSEHOLD_FINANCE_TERMS})\\b`, "i")],
  ["finances", /\b(?:my|our)\s+(?:\w+\s+){0,2}(?:IRA|Roth)\b/],
  ["finances", /\bi\s+(?:owe|earn|earned|inherited)\b|\bi(?:'m| am)\s+(?:in debt|broke)\b/i],
  ["family", new RegExp(`\\bmy\\s+(?:\\w+\\s+)?(?:${FAMILY_TERMS})\\b`, "i")],
  ["family", /\b(?:i'?m|i am)\s+(?:getting\s+(?:married|divorced)|engaged|expecting)\b|\bour baby\b/i],
  ["location", new RegExp(`\\bmy\\s+(?:\\w+\\s+){0,2}(?:${LOCATION_TERMS})\\b(?!\\s*(?:dir|directory|folder|network|server|lab|router|assistant|page|screen|config|office|machine|setup|nas|wifi|wi-fi))`, "i")],
  ["location", /\bmy\s+(?:home\s+)?address\s+is\b/i],
  ["location", new RegExp(`\\bwe\\s+live\\s+(?:in|near|on|at)\\s+(?!(?:${DEST_TECH}|${DEST_ARTICLE})\\b)[a-z]`, "i")],
  ["location", new RegExp(`\\b(?:i|we)(?:'re|'m| am| are|'ve| have)?\\s+(?:relocating|relocated)\\s+to\\s+(?!(?:${DEST_TECH}|${DEST_ARTICLE})\\b)[a-z]`, "i")],
  ["location", new RegExp(`\\bi(?:'m| am|'ve| have)?\\s+(?:moving|moved)\\s+to\\s+(?!(?:${DEST_TECH}|${DEST_ARTICLE})\\b)[a-z]`, "i")],
  ["location", new RegExp(`\\bi\\s+live\\s+(?:in|on|at|near)\\s+(?!(?:${DEST_TECH})\\b)[a-z]`, "i")],
  ["location", /\bi\s+live\s+(?:with|next|by|just)\b/i],
  ["location", /\bwe\s+live\s+in\s+(?:a|an|the)\s+(?:\w+\s+)?(?:house|apartment|flat|town|city|village|suburb|neighbou?rhood|condo)\b/i],
  ["location", /\b(?:i|we)(?:'ve| have)?\s+(?:moved|moving|relocated|relocating)\s+(?:in)?to\s+(?:a|an|the|my|our)\s+(?:\w+\s+)?(?:house|apartment|flat|home|town|city|suburb|neighbou?rhood|condo)\b/i],
  ["schedule", /\bi(?:'ll| will|'m| am)\s+(?:be\s+)?(?:away|unavailable|offline|out of (?:the )?office|on (?:\w+\s+)?(?:vacation|holiday|leave|pto)|out (?:from|until|on|next|this|all|for)|off (?:on|from|until|next|this|for)|(?:travell?ing|flying)\s+(?:to|on|next|from))\b/i],
  ["schedule", /\b[Ii](?:'ll| will|'m| am)\s+(?:be\s+)?in\s+[A-Z]\w+(?:\s+[A-Z]\w+)?\s+(?:(?:on|from|until|for|between|the)\s+)?\d/],
  ["schedule", /\bmy\s+(?:\w+\s+){0,2}(?:vacation|holidays?|days? off|day off|trip|flight|travel plans(?!\s+(?:module|service|api|page|feature|endpoint|component|table|screen))|routine|gym|bedtime|commute|sabbatical|time off|pto)\b/i],
  ["schedule", /\b(?:i|we)\b[^.!?\n]{0,30}?\b(?:travel\w*|fly|flying|flew)\s+to\s+\w/i],
  ["schedule", /\b(?:i|we)(?:'m|'ll|'re| am| will| are)?\s+(?:be\s+)?heading\s+(?:out\s+)?to\s+\S+(?:\s+\S+)?\s+(?:on|next|for)\b/i],
  ["schedule", /\bi\s+(?:wake up|go to bed|go to the gym)\b/i],
  ["business_terms", /\bmy\s+(?:\w+\s+){0,2}(?:rates?\b(?!\s+limit)|fees?\b|retainer|invoices?\b|contract(?!s?\s+tests?)\b|pricing|billing rate)/i],
  // "we invoice customers through Coupa" is how a team runs billing (a work fact); "I invoice" is the user's own.
  ["business_terms", /\b(?:i|i'm)\s+(?:charge|charged|invoice|invoiced|invoicing|bill|billed)\b/i],
  ["business_terms", /\b(?:owes?|owed|pays?|paying|paid)\s+me\b|\bi(?:'m| am)\s+owed\b/i],
  ["business_terms", /\b(?:i|i'm|we|we're|my)\b[^.!?\n]{0,25}\bnegotiat\w*\s+(?:\w+\s+){0,2}(?:rates?|fees?|contract|terms|retainer|raise|price|pricing|deal|salary)\b/i],
  // A dispute somebody is in ("a payment dispute over/with …", "my billing dispute"), not the "payment disputes" webhook.
  ["business_terms", /\b(?:a|an|the|my|our|this|that)\s+(?:\w+\s+)?(?:payment|invoice|billing|fee) dispute\s+(?:over|with|about|regarding|against)\b|\b(?:my|i|i'm|i've)\b[^.!?\n]{0,30}?\b(?:payment|invoice|billing|fee) disputes?\b/i],
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
  [{ tier: "candid", category: "about_others" }, new RegExp(`\\b${NAME}(?:'s)?\\s+${LEAD}${PRIVATE_LIFE}`, "i")],
  [{ tier: "candid", category: "about_others" }, new RegExp(`\\b${NAME}'s\\s+(?:salary|pay|bonus|compensation|income)\\b`, "i")],
  [{ tier: "candid", category: "about_others" }, new RegExp(`\\b${NAME}\\s+(?:earns\\s+(?:about |around )?[$£€]?\\s?\\d|(?:makes|is paid|gets paid)\\s+(?:about |around )?[$£€]\\s?\\d)`, "i")],
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
