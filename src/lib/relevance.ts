// src/lib/relevance.ts
export type Relevance = {
  score: number;   // higher = more likely investment
  reasons: string[];
};

const POS = [
  "invest", "investment", "fdi", "capex", "crore", "cr", "₹", "inr",
  "plant", "factory", "unit", "manufactur", "assembly", "facility",
  "park", "sez", "industrial estate", "industrial park", "cluster",
  "greenfield", "brownfield", "expansion", "commissioned", "groundbreaking",
  "jobs", "employment",
  "semiconductor", "chip", "foundry", "atmp", "osat", "pcb",
  "ev", "battery", "cell", "cathode", "anode", "gigafactory",
  "steel", "cement", "refinery", "petrochem", "chemical", "fertilizer",
  "textile", "garment", "apparel",
  "pharma", "biotech", "api", "vaccine",
  "electronics", "ems", "solar", "module", "ingot", "wafer"
];

const NEG_HARD = [
  "cabinet expansion", "cabinet reshuffle", "election", "polls", "voting",
  "rally", "campaign", "politics", "minister sworn", "oath",
  "crime", "accident", "weather alert", "sport", "match"
];

// Softer “event” words — small penalty only
const NEG_SOFT = [
  "workshop", "training", "seminar", "conference", "awareness", "hackathon", "webinar"
];

// patterns
const AMOUNT = /(?:₹|inr|rs\.?)\s*\d[\d,]*(?:\.\d+)?\s*(?:cr|crore|lakh|lac)/i;
const JOBS = /\b\d{2,5}\s+(?:jobs?|people|employment|employees)\b/i;
const COMPANY = /\b([A-Z][A-Za-z0-9&.\- ]{2,}?\s(?:Pvt\.?\s*Ltd|Private Limited|Ltd\.?|Limited|LLP|Inc\.?|Corporation|Corp\.?))\b/;

// category regexes
const RE_MOU = /\bMoU\b|\bmemorandum of understanding\b/i;
const RE_INTENT = /\bintent\b|\bLoI\b|\bletter of intent\b/i;
const RE_PROPOSAL = /\bproposal(s)?\b|\bproposed\b|\bproposal worth\b/i;
const RE_EXPANSION = /\bexpansion\b|\bexpand\b|\bcapacity (?:increase|addition|expansion)\b|\bbrownfield\b/i;

// “Education/social only” context for MoUs (we'll exclude those)
const RE_EDU_SOCIAL = /(unesco|ncert|school|teacher education|curriculum|students|wellbeing|health & wellbeing)/i;

/** Heuristic relevance scoring for "investment-likeness". */
export function relevanceScore(title: string, text: string = ""): Relevance {
  const T = (title || "").toLowerCase();
  const X = (text || "").toLowerCase();

  let score = 0;
  const reasons: string[] = [];

  // Hard negatives — politics, sports, etc.
  for (const n of NEG_HARD) {
    if (T.includes(n) || X.includes(n)) {
      reasons.push(`neg-hard:${n}`);
      score -= 5;
    }
  }

  // Amount / jobs / company presence
  if (AMOUNT.test(T) || AMOUNT.test(X)) { score += 4; reasons.push("amount"); }
  if (JOBS.test(T) || JOBS.test(X)) { score += 2; reasons.push("jobs"); }
  if (COMPANY.test(title) || COMPANY.test(text)) { score += 2; reasons.push("company-entity"); }

  // Positive keywords
  for (const p of POS) {
    if (T.includes(p)) { score += 1; reasons.push(`pos-title:${p}`); }
    else if (X.includes(p)) { score += 0.5; reasons.push(`pos-text:${p}`); }
  }

  // Soft negatives lightly penalize
  let softPen = 0;
  for (const n of NEG_SOFT) {
    if (T.includes(n) || X.includes(n)) softPen -= 1;
  }
  score += softPen;

  // MoU handling: penalize **only** if clearly education/social without industrial cues or amounts
  const hasMoU = RE_MOU.test(title) || RE_MOU.test(text);
  const educationish = RE_EDU_SOCIAL.test(T + " " + X);
  const hasIndustrialContext = POS.some(p => T.includes(p) || X.includes(p));
  if (hasMoU && educationish && !hasIndustrialContext && !AMOUNT.test(T + " " + X)) {
    score -= 3;
    reasons.push("mou-education-nonindustrial");
  }

  if (reasons.length > 16) reasons.length = 16;

  return { score, reasons };
}

/** Classify into our dashboard categories: intent / mou / proposal / expansion / other */
export function classifyInvestmentCategory(title: string, text: string = ""): "intent" | "mou" | "proposal" | "expansion" | "other" {
  // Order matters: detect the most specific signal first
  if (RE_EXPANSION.test(title) || RE_EXPANSION.test(text)) return "expansion";
  if (RE_PROPOSAL.test(title) || RE_PROPOSAL.test(text)) return "proposal";
  if (RE_INTENT.test(title) || RE_INTENT.test(text)) return "intent";

  // MoU only if not education/social-only
  const hasMoU = RE_MOU.test(title) || RE_MOU.test(text);
  const educationish = RE_EDU_SOCIAL.test((title + " " + text).toLowerCase());
  if (hasMoU && !educationish) return "mou";

  return "other";
}

/** Convenience: threshold check if you need it somewhere */
export function isInvestmentLike(title: string, text: string = "", threshold = 1): boolean {
  const { score } = relevanceScore(title, text);
  return score >= threshold;
}
