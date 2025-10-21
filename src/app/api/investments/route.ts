// src/app/api/investments/route.ts
import type { Investment } from "@/lib/types";

// Discovery
import { discoverViaGdelt } from "@/lib/sources/gdelt";
import { discoverViaGoogleNews, mergeDiscoveryUnique } from "@/lib/sources/googleNews";

// LLM extraction
import { extractStructured, buildPromptPreview } from "@/lib/extract";

// Pipeline utils
import { normalizeRecords } from "@/lib/normalize";
import { scoreRecords } from "@/lib/score";
import { enrichFromHeuristics, toInvestment } from "@/lib/enrich";
import { boostMissing } from "@/lib/boost";
import { relevanceScore, classifyInvestmentCategory } from "@/lib/relevance";
import { maxInrAmountCrore } from "@/lib/amount";
import { isExplicitForState } from "@/lib/geo";

export const runtime = "nodejs";
export const maxDuration = 60; // 60 seconds timeout

/* ----------------------- ENV switches ----------------------- */
const DISCOVERY_SOURCE =
  (process.env.DISCOVERY_SOURCE || "gnews").toLowerCase() as "gnews" | "gdelt" | "both";
const EXTRACTION_MODE =
  (process.env.EXTRACTION_MODE || "ai").toLowerCase() as "ai" | "heuristic";
const AI_WHITELIST_MODE =
  (process.env.AI_WHITELIST_MODE || "ai").toLowerCase() as "hard" | "ai";
const ALLOW_QUERY_OVERRIDES = process.env.ALLOW_QUERY_OVERRIDES === "1";

/* ----------------------- Constants -------------------------- */
const ALLOWED_SOURCES_FOR_AI = new Set<string>([
  "economictimes.indiatimes.com",
  "business-standard.com",
  "livemint.com",
  "financialexpress.com",
  "moneycontrol.com",
  "businesstoday.in",
  "thehindubusinessline.com",
]);

const MAX_RECORDS = 100; // Increased from 60 to 100 for better multi-state coverage
const BATCH_SIZE = 6;
const ALLOWED_CATS = new Set(["intent", "mou", "proposal", "expansion"]);

/* ------------------------- Utils ---------------------------- */
function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function cleanHost(u?: string | null): string | null {
  try {
    if (!u) return null;
    const host = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

const PUBLISHER_NAME_TO_DOMAIN: Record<string, string> = {
  "economic times": "economictimes.indiatimes.com",
  "the economic times": "economictimes.indiatimes.com",
  "business standard": "business-standard.com",
  "mint": "livemint.com",
  "live mint": "livemint.com",
  "financial express": "financialexpress.com",
  "moneycontrol": "moneycontrol.com",
  "business today": "businesstoday.in",
  "the hindu businessline": "thehindubusinessline.com",
};

function resolveSourceDomain(a: { url: string; source?: string | null }): string | null {
  const urlHost = cleanHost(a.url);
  if (urlHost) return urlHost;
  const src = (a.source || "").toLowerCase().trim();
  if (src) {
    if (/^https?:\/\//i.test(src)) {
      const h = cleanHost(src);
      if (h) return h;
    }
    const mapped =
      PUBLISHER_NAME_TO_DOMAIN[src] ||
      PUBLISHER_NAME_TO_DOMAIN[src.replace(/^the\s+/, "")] ||
      null;
    if (mapped) return mapped;
  }
  return null;
}

function isWhitelistedDomain(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  for (const allowed of ALLOWED_SOURCES_FOR_AI) {
    if (d === allowed) return true;
    if (d.endsWith("." + allowed)) return true;
  }
  return false;
}

/* ---------------- Govt / PSU tagging helpers ---------------- */
const PSU_MAP: Record<string, string> = {
  ntpc: "NTPC",
  "indian oil": "Indian Oil Corporation",
  iocl: "Indian Oil Corporation",
  bpcl: "Bharat Petroleum Corporation (BPCL)",
  "bharat petroleum": "Bharat Petroleum Corporation (BPCL)",
  hpcl: "Hindustan Petroleum Corporation (HPCL)",
  bhel: "Bharat Heavy Electricals (BHEL)",
  sail: "Steel Authority of India (SAIL)",
  gail: "GAIL (India) Limited",
  ongc: "Oil and Natural Gas Corporation (ONGC)",
  "power grid": "Power Grid Corporation of India (PGCIL)",
  "coal india": "Coal India Limited",
  nmdc: "NMDC",
  nalco: "NALCO",
  bel: "Bharat Electronics (BEL)",
  hal: "Hindustan Aeronautics (HAL)",
};

const CENTRAL_HINTS = [
  "prime minister",
  "pm modi",
  "narendra modi",
  "union minister",
  "government of india",
  "central government",
  "ministry of",
  "nhai",
  "iit ",
  "aiims",
  "niti aayog",
];

const STATE_HINTS = [
  "chief minister",
  "state cabinet",
  "state government",
  "industries department",
  "industrial development corporation",
];

/* ------------ Weird AI repair (company/sector sanity) ------- */
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function textHasAny(text: string, hints: string[]): boolean {
  const T = (text || "").toLowerCase();
  return hints.some((h) => T.includes(h));
}
function detectPSUName(text: string): string | null {
  const T = (text || "").toLowerCase();
  for (const key of Object.keys(PSU_MAP)) {
    if (T.includes(key)) return PSU_MAP[key];
  }
  return null;
}
function isGenericCompanyName(name?: string | null): boolean {
  if (!name) return true;
  return /\b(govt|government|department|ministry|authority|board|corporation|council)\b/i.test(name);
}

function repairWeirdAI(rec: Investment, pageText: string): Investment {
  const text = pageText || "";
  let out = { ...rec };

  // Foxconn/Hon Hai normalization
  if (/\b(foxconn|hon hai)\b/i.test(text) || /\b(foxconn|hon hai)\b/i.test(out.company || "")) {
    out.company = "Foxconn (Hon Hai Precision Industry)";
    const isAuto = /\b(car|vehicle|ev|two[- ]wheeler|scooter|bus|truck|oem|automobile)\b/i.test(text);
    const isSemi = /\b(semiconductor|chip|fab|foundry|atmp|osat|wafer)\b/i.test(text);
    out.sector = isAuto ? "Automobile" : (isSemi ? "Semiconductor" : "Electronics/EMS");
  }

  // If company doesn't appear in article text (and not government/PSU), clear it
  if (out.company) {
    const re = new RegExp(`\\b${escapeRegExp(out.company)}\\b`, "i");
    const isGovt =
      /\b(government|govt|ministry|department|authority|board|corporation|council|psu)\b/i.test(out.company);
    if (!re.test(text) && !isGovt) {
      out.rationale = (out.rationale ? out.rationale + "; " : "") + "company cleared (not found in article text)";
      out.company = null;
    }
  }

  // Sector repair to avoid false 'Automobile'
  if (out.sector === "Automobile") {
    const hasAuto =
      /\b(car|vehicle|ev|two[- ]wheeler|scooter|bus|truck|oem|automobile|auto\s*plant)\b/i.test(text);
    if (!hasAuto) {
      const hasElectronics =
        /\b(iphone|phone|smartphone|ems|assembly|electronics|pcb|module|display|connector|smt|ems provider)\b/i.test(text);
      const hasSemi = /\b(semiconductor|chip|fab|foundry|atmp|osat|wafer)\b/i.test(text);
      if (hasSemi) out.sector = "Semiconductor";
      else if (hasElectronics) out.sector = "Electronics/EMS";
    }
  }

  return out;
}

/* --------- Sector refinement with energy/company-aware overrides --------- */
function refineSector(rec: Investment, pageText: string): Investment {
  const t = (pageText || "").toLowerCase();
  const cmp = (rec.company || "").toLowerCase();
  let sector = rec.sector || null;

  const has = (re: RegExp) => re.test(t) || re.test(cmp);

  // Keyword families
  const GREEN_H2   = /\bgreen\s+hydrogen\b|\bh2\b.*\bgreen\b/i;
  const RENEW      = /\b(renewable|solar|pv|wind|onshore|offshore|hybrid\s*park|solar\s*park)\b/i;
  const THERMAL    = /\b(thermal|coal|lignite|supercritical|ultra[-\s]*mega|u\W?mpp|mw|gw)\b/i;
  const POWER_MISC = /\b(power\s*plant|power\s*project|generation\s*capacity|pumped\s*storage)\b/i;

  const OILGAS     = /\b(oil|upstream|downstream|petroleum|exploration|offshore\s*block|onshore\s*block)\b/i;
  const REFINERY   = /\b(refinery|refining|crude\s*distillation|petrochemical|cracker|naphtha|aromatics|polymer)\b/i;
  const GAS_CHAIN  = /\b(lng|regasification|terminal|cg d|city\s*gas|pipeline|gas\s*grid|gasification)\b/i;

  const CEMENT     = /\b(cement|ultratech|ambuja|acc\b|shree\s+cement|dalmia|jk\s+cement|ramco\s+cement|birla\s+corp|penna\s+cement|zuari\s+cement)\b/i;
  const STEEL      = /\b(steel|ferro|sponge\s*iron|blast\s*furnace)\b/i;

  // tightened IT
  const IT         = /\b(it\s*park|tech\s*park|software|infotech|information\s+technology|it\s*services|saas|erp|bpo|kpo|it[-\s]*ites|ites)\b/i;
  const DATACENTER = /\b(data\s*centre|data\s*center|hyperscale|colocation|server\s*farm)\b/i;

  const SEMI       = /\b(semiconductor|chip|fab|foundry|atmp|osat|wafer)\b/i;
  const ELECTR     = /\b(ems|electronics|pcb|connector|assembly|display|smt)\b/i;
  const AUTO       = /\b(ev|automobile|auto(?!\s*pilot)|oem|car|bus|truck|two[-\s]?wheeler|scooter|vehicle)\b/i;

  // Company families
  const IS_BPCL = /\b(bpcl|bharat\s+petroleum)\b/i.test(cmp);
  const IS_IOCL = /\b(iocl|indian\s+oil)\b/i.test(cmp);
  const IS_HPCL = /\b(hpcl|hindustan\s+petroleum)\b/i.test(cmp);
  const IS_ONGC = /\b(ongc)\b/i.test(cmp);
  const IS_GAIL = /\b(gail)\b/i.test(cmp);

  const IS_NTPC = /\b(ntpc)\b/i.test(cmp);
  const IS_NHPC = /\b(nhpc)\b/i.test(cmp);
  const IS_PGCIL = /\b(power\s*grid|pgcil)\b/i.test(cmp);

  // Overrides
  if (IS_BPCL || IS_IOCL || IS_HPCL || IS_ONGC || IS_GAIL) {
    if (has(REFINERY) || /refinery|petrochem/i.test(t)) sector = "Refinery & Petrochemicals";
    else if (has(GAS_CHAIN)) sector = "Gas & Pipelines";
    else if (has(OILGAS)) sector = "Oil & Gas";
    else if (has(GREEN_H2)) sector = "Green Hydrogen";
    else if (has(RENEW)) sector = "Renewable Energy";
    else if (has(POWER_MISC)) sector = "Power Generation";
    else sector = sector || "Oil & Gas";
  }
  if (IS_NTPC || IS_NHPC || IS_PGCIL) {
    if (has(GREEN_H2)) sector = "Green Hydrogen";
    else if (has(RENEW)) sector = "Renewable Energy";
    else if (has(THERMAL) || has(POWER_MISC)) sector = "Power Generation";
    else sector = IS_PGCIL ? "Power (Transmission)" : (sector || "Power Generation");
  }

  if (!sector) {
    if (has(CEMENT)) sector = "Cement";
    else if (has(DATACENTER)) sector = "IT/Data Centre";
    else if (has(IT)) sector = "IT/Software";
    else if (has(SEMI)) sector = "Semiconductor";
    else if (has(ELECTR)) sector = "Electronics/EMS";
    else if (has(STEEL)) sector = "Steel";
    else if (has(GREEN_H2)) sector = "Green Hydrogen";
    else if (has(REFINERY)) sector = "Refinery & Petrochemicals";
    else if (has(GAS_CHAIN)) sector = "Gas & Pipelines";
    else if (has(OILGAS)) sector = "Oil & Gas";
    else if (has(RENEW)) sector = "Renewable Energy";
    else if (has(THERMAL) || has(POWER_MISC)) sector = "Power Generation";
    else if (has(AUTO)) sector = "Automobile";
  }

  if (sector === "Steel" && /cement/i.test(t)) sector = "Cement";
  if (sector === "Automobile" && /infotech|software|technolog(y|ies)\b/i.test(cmp)) sector = "IT/Software";
  if ((/oil|petroleum|refinery|petrochem|lng|pipeline|cg d/i.test(t)) && sector && /IT/.test(sector)) {
    sector = /refinery|petrochem/i.test(t) ? "Refinery & Petrochemicals"
         : /lng|pipeline|cg d|gas\s*grid/i.test(t) ? "Gas & Pipelines"
         : "Oil & Gas";
  }
  if (/\bgreen\s+hydrogen\b/i.test(t)) sector = "Green Hydrogen";

  if (sector !== rec.sector) {
    return {
      ...rec,
      sector,
      rationale: rec.rationale
        ? `${rec.rationale}; sector refined to ${sector}`
        : `Sector refined to ${sector}`,
    };
  }
  return rec;
}

/* ---------------- Company canonicalization (short) ---------- */
const ORG_DICT: Array<[RegExp, string]> = [
  [/\btata\s+group\b/i, "Tata Group"],
  [/\breliance\s+industries\b/i, "Reliance Industries"],
  [/\badani\s+group\b/i, "Adani Group"],
  [/\bjsw\s+group\b/i, "JSW Group"],
  [/\bultratech\s+cement\b/i, "UltraTech Cement"],
  [/\bfoxconn|hon\s+hai\b/i, "Foxconn (Hon Hai Precision Industry)"],
  [/\bntpc\b/i, "NTPC"],
  [/\bindian\s+oil\b|\biocl\b/i, "Indian Oil Corporation"],
  [/\bbpcl|bharat\s+petroleum\b/i, "Bharat Petroleum Corporation (BPCL)"],
  [/\bhpcl|hindustan\s+petroleum\b/i, "Hindustan Petroleum Corporation (HPCL)"],
  [/\bongc\b/i, "Oil and Natural Gas Corporation (ONGC)"],
  [/\bgail\b/i, "GAIL (India) Limited"],
];

function isBadCompanyName(s?: string | null): boolean {
  if (!s) return true;
  const str = s.trim();
  if (!str) return true;
  if (/\bas\b.+\b(invest|investment|hub)\b/i.test(str)) return true;
  if (/\b(government|govt|state|minister|cabinet)\b/i.test(str)) return true;
  if (str.split(/\s+/).length > 7) return true;
  if (!/[A-Za-z]/.test(str)) return true;
  return false;
}
function findCompanyInTextByDict(text: string): string | null {
  for (const [re, name] of ORG_DICT) {
    if (re.test(text)) return name;
  }
  return null;
}
async function canonicalizeCompany(
  current: string | null | undefined,
  pageText: string,
  title: string
): Promise<{ company: string | null; note?: string }> {
  const text = `${title} ${pageText}`;
  if (current && !isBadCompanyName(current)) {
    const present = new RegExp(`\\b${escapeRegExp(current)}\\b`, "i").test(text);
    if (present) return { company: current };
  }
  const byDict = findCompanyInTextByDict(text);
  if (byDict) return { company: byDict, note: "company fixed via dictionary" };
  return { company: current && !isBadCompanyName(current) ? current : null };
}

/* ---------------- Types for local flow ---------------------- */
type DiscoveredWithText = {
  title: string;
  url: string;
  source: string | null;
  iso_date: string | null;
  tagged_state: string;       // legacy single state
  tagged_states: string[];    // union of all matched states for this URL
  text: string;
  __rel?: any;
  __cat?: string;
};

/* ---------------- Preferred domains ------------------------ */
const SOURCE_PRIORITY = [
  "economictimes.indiatimes.com",
  "business-standard.com",
  "livemint.com",
  "financialexpress.com",
  "moneycontrol.com",
  "businesstoday.in",
  "thehindubusinessline.com",
  "thehindu.com",
  "timesofindia.indiatimes.com",
  "newindianexpress.com",
];

function priorityOf(domain?: string | null): number {
  if (!domain) return 999;
  const d = (domain || "").toLowerCase();
  const idx = SOURCE_PRIORITY.findIndex((s) => d === s || d.endsWith("." + s));
  return idx >= 0 ? idx : 500;
}
function countFilledFields(r: Investment): number {
  const fields: Array<keyof Investment> = [
    "company","sector","amount_in_inr_crore","jobs","state","district","project_type","status","announcement_date"
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fields.reduce((n, k) => n + ((r as any)[k] != null ? 1 : 0), 0);
}
function chooseBestRecord(a: Investment, b: Investment): Investment {
  const pa = priorityOf(a.source_name || (a as any).__source_domain);
  const pb = priorityOf(b.source_name || (b as any).__source_domain);
  if (pa !== pb) return pa < pb ? a : b;

  const fa = countFilledFields(a), fb = countFilledFields(b);
  if (fa !== fb) return fb > fa ? b : a;

  const aa = a.amount_in_inr_crore ?? -1, bb = b.amount_in_inr_crore ?? -1;
  if (aa !== bb) return bb > aa ? b : a;

  const da = Date.parse(a.announcement_date || "") || 0;
  const db = Date.parse(b.announcement_date || "") || 0;
  if (da !== db) return db > da ? b : a;

  return a;
}

/* ======================= DEDUPE HELPERS ======================= */
function normalizeUrlStrict(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return (u || "").trim().toLowerCase();
  }
}
function normStrict(s?: string | null): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/** normalize to YYYY-MM-DD (UTC) */
function dayString(d?: string | null): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return null;
  const dt = new Date(t);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function withinOneDay(a?: string | null, b?: string | null): boolean {
  const as = dayString(a), bs = dayString(b);
  if (!as || !bs) return false;
  const ae = Date.parse(as + "T00:00:00Z");
  const be = Date.parse(bs + "T00:00:00Z");
  const diffDays = Math.abs(ae - be) / (1000 * 3600 * 24);
  return diffDays <= 1;
}
function dedupeByStateAmountDate(records: Investment[]): Investment[] {
  // Stage 1: URL-based dedupe
  const byUrl = new Map<string, Investment>();
  for (const r of records) {
    const key = normalizeUrlStrict(r.source_url);
    const existing = byUrl.get(key);
    if (!existing) byUrl.set(key, r);
    else byUrl.set(key, chooseBestRecord(existing, r));
  }
  const urlDeduped = Array.from(byUrl.values());

  // Stage 2: Cross-state deduplication by amount and date
  // Group by amount and date, then dedupe across different states
  type CrossStateBucket = { amtInt: number; dateStr: string; items: Investment[] };
  const crossStateBuckets = new Map<string, CrossStateBucket>(); // key = `${amtInt}|${dateStr}`

  for (const r of urlDeduped) {
    const amt = r.amount_in_inr_crore;
    const dateStr = dayString(r.announcement_date);
    
    if (amt == null || !Number.isFinite(amt) || !dateStr) continue;
    
    const amtInt = Math.round(Number(amt));
    const key = `${amtInt}|${dateStr}`;
    const bucket = crossStateBuckets.get(key) || { amtInt, dateStr, items: [] };
    bucket.items.push(r);
    crossStateBuckets.set(key, bucket);
  }

  const winners: Investment[] = [];
  const used = new Set<Investment>();

  // Process cross-state buckets
  for (const [, bucket] of crossStateBuckets) {
    if (bucket.items.length === 1) {
      winners.push(bucket.items[0]);
      used.add(bucket.items[0]);
      continue;
    }

    // For multiple items with same amount and date, choose the best one
    // Priority: higher opportunity_score, then has company, then newer date, then source priority
    const sorted = bucket.items.sort((a, b) => {
      // First by opportunity score
      if (a.opportunity_score !== b.opportunity_score) {
        return b.opportunity_score - a.opportunity_score;
      }
      
      // Then by whether it has company info
      const aHasCompany = a.company ? 1 : 0;
      const bHasCompany = b.company ? 1 : 0;
      if (aHasCompany !== bHasCompany) {
        return bHasCompany - aHasCompany;
      }
      
      // Then by source priority
      const aPriority = priorityOf(a.source_name || (a as any).__source_domain);
      const bPriority = priorityOf(b.source_name || (b as any).__source_domain);
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      
      // Finally by date (newer first)
      const aDate = Date.parse(a.announcement_date || "") || 0;
      const bDate = Date.parse(b.announcement_date || "") || 0;
      return bDate - aDate;
    });

    const best = sorted[0];
    winners.push(best);
    used.add(best);
  }

  // Stage 3: Traditional state-specific clustering for remaining items
  type Bucket = { stateKey: string; amtInt: number; items: Investment[] };
  const buckets = new Map<string, Bucket>(); // key = `${stateKey}|${amtInt}`

  for (const r of urlDeduped) {
    if (used.has(r)) continue;
    
    const st = normStrict(r.state);
    const amt = r.amount_in_inr_crore;
    if (!st || amt == null || !Number.isFinite(amt)) continue;
    const amtInt = Math.round(Number(amt));
    const key = `${st}|${amtInt}`;
    const b = buckets.get(key) || { stateKey: st, amtInt, items: [] };
    b.items.push(r);
    buckets.set(key, b);
  }

  for (const [, bucket] of buckets) {
    const arr = bucket.items
      .filter((x) => !!dayString(x.announcement_date))
      .sort((a, b) => (Date.parse(b.announcement_date || "") || 0) - (Date.parse(a.announcement_date || "") || 0));

    const taken = new Set<number>();
    for (let i = 0; i < arr.length; i++) {
      if (taken.has(i)) continue;
      let best = arr[i];

      for (let j = i + 1; j < arr.length; j++) {
        if (taken.has(j)) continue;
        if (withinOneDay(arr[i].announcement_date, arr[j].announcement_date)) {
          best = chooseBestRecord(best, arr[j]);
          taken.add(j);
        }
      }
      winners.push(best);
      used.add(best);
    }

    // add items without a valid date string
    for (const r of bucket.items) {
      if (!dayString(r.announcement_date) && !used.has(r)) {
        winners.push(r);
        used.add(r);
      }
    }
  }

  // Add back urlDeduped items that couldn't be clustered
  for (const r of urlDeduped) {
    const st = normStrict(r.state);
    const amt = r.amount_in_inr_crore;
    if (!st || amt == null || !Number.isFinite(amt)) {
      if (!used.has(r)) {
        winners.push(r);
        used.add(r);
      }
    }
  }

  // Preserve input order
  const ordered: Investment[] = [];
  const seen = new Set<Investment>();
  for (const r of records) {
    const found = winners.find((w) => w === r);
    if (found && !seen.has(found)) {
      ordered.push(found);
      seen.add(found);
    }
  }
  for (const w of winners) {
    if (!seen.has(w)) {
      ordered.push(w);
      seen.add(w);
    }
  }

  return ordered;
}

/* ================== STATE ALIASES / CITIES ================== */

const STATE_ALIASES: Record<string, string[]> = {
  "Andhra Pradesh": [
    "andhra pradesh", "\\bap\\b", "visakhapatnam", "vizag", "vishakhapatnam",
    "vijayawada", "guntur", "tirupati", "ananthapur|anantapur", "kurnool",
    "kakinada", "rajahmundry", "sri city", "tada", "nellore", "ongole",
    "srikakulam", "machilipatnam", "eluru", "hindupur"
  ],
  "Arunachal Pradesh": ["arunachal pradesh", "itanagar", "pasighat", "naharlagun", "roing", "tezpur"],
  Assam: ["assam", "guwahati", "dibrugarh", "tinsukia", "jorhat", "tezpur", "silchar", "bongaigaon", "nagaon"],
  Bihar: ["bihar", "patna", "gaya", "muzaffarpur", "bhagalpur", "begusarai", "darbhanga", "ara", "hajipur"],
  Chhattisgarh: ["chhattisgarh", "raipur", "bilaspur", "korba", "durg", "bhilai", "raigarh", "ambikapur", "jagdalpur"],
  Goa: ["goa", "panaji|panjim", "mormugao|mormugoa", "verna", "vasco", "ponda", "mapusa"],
  Gujarat: [
    "gujarat", "ahmedabad", "gandhinagar", "surat", "vadodara|baroda", "bharuch",
    "dahej", "hazira", "jamnagar", "rajkot", "morbi", "mundra", "kandla",
    "anand", "mehsana", "bhavnagar", "vapi", "sanand", "dholera", "halol"
  ],
  Haryana: [
    "haryana", "gurugram|gurgaon", "faridabad", "manesar", "panipat",
    "sonipat|sonepat", "bahadurgarh", "hisar", "rohtak", "karnal", "ambala",
    "panchkula", "rewari", "yamunanagar", "bawal"
  ],
  "Himachal Pradesh": ["himachal pradesh", "shimla", "baddi", "solan", "una", "kangra", "hamirpur", "mandi", "bilaspur"],
  Jharkhand: ["jharkhand", "ranchi", "jamshedpur", "bokaro", "dhanbad", "deoghar", "hazaribagh", "dumka"],
  Karnataka: [
    "karnataka", "\\bk\\'?taka\\b", "bengaluru|bangalore", "mysuru|mysore", "hubballi|hubli", "dharwad",
    "mangaluru|mangalore", "belagavi|belgaum", "ballari|bellary", "tumakuru|tumkur",
    "hosakote|hoskote", "kolar", "shivamogga|shimoga", "hassan", "bidar", "davangere", "raichur", "hosur karnataka" // (guard)
  ],
  Kerala: [
    "kerala", "kochi|cochin", "ernakulam", "thiruvananthapuram|trivandrum", "kollam",
    "alappuzha|alleppey", "kozhikode|calicut", "kannur", "palakkad|palghat",
    "thrissur|trichur", "kottayam", "malappuram"
  ],
  "Madhya Pradesh": [
    "madhya pradesh", "\\bmp\\b", "indore", "bhopal", "pithampur", "jabalpur", "gwalior",
    "mandideep", "singrauli", "satna", "rewa", "ujjain", "sagar", "khandwa", "ratlam"
  ],
  Maharashtra: [
    "maharashtra", "mumbai", "navi mumbai", "thane", "pune", "chakan", "ranjangaon",
    "aurangabad|chhatrapati sambhajinagar", "nagpur", "nashik|nasik", "satara", "kolhapur",
    "raigad", "palghar", "waluj", "talegaon", "hinjewadi", "bhiwandi", "jalna"
  ],
  Manipur: ["manipur", "imphal", "churachandpur", "thoubal"],
  Meghalaya: ["meghalaya", "shillong", "tura", "jowai"],
  Mizoram: ["mizoram", "aizawl", "lunglei"],
  Nagaland: ["nagaland", "kohima", "dimapur"],
  Odisha: [
    "odisha|orissa", "bhubaneswar", "cuttack", "paradip|paradeep", "jajpur", "angul",
    "jharsuguda", "sambalpur", "rourkela", "sundargarh", "kalinganagar", "dhamra", "balasore|baleshwar", "ganjam", "rayagada", "khurda|khordha"
  ],
  Punjab: ["punjab", "mohali", "ludhiana", "amritsar", "jalandhar", "bathinda", "patiala", "rajpura", "zirakpur", "dera bassi"],
  Rajasthan: [
    "rajasthan", "jaipur", "udaipur", "jodhpur", "bhiwadi", "neemrana", "alwar",
    "kota", "bhilwara", "beawar", "chittorgarh", "ganganagar|sri ganganagar"
  ],
  Sikkim: ["sikkim", "gangtok"],
  "Tamil Nadu": [
    "tamil nadu", "\\btn\\b", "chennai", "coimbatore", "tiruppur|tirupur", "hosur",
    "sriperumbudur", "chengalpattu|kanchipuram", "madurai", "trichy|tiruchirappalli",
    "salem", "namakkal", "thoothukudi|tuticorin", "tirunelveli", "ambattur", "oragadam"
  ],
  Telangana: [
    "telangana", "hyderabad", "warangal", "karimnagar", "nizamabad", "sangareddy",
    "adibatla", "mahbubnagar|mahbubnag ar|mahabubnagar", "zaheerabad", "kompally"
  ],
  Tripura: ["tripura", "agartala"],
  "Uttar Pradesh": [
    "uttar pradesh", "\\bup\\b", "noida", "greater noida", "ghaziabad", "jewar", "lucknow",
    "kanpur", "varanasi|benaras", "gorakhpur", "agra", "aligarh", "meerut", "prayagraj|allahabad",
    "ayodhya|faizabad", "mathura"
  ],
  Uttarakhand: ["uttarakhand", "dehradun", "haridwar", "rudrapur", "kashipur", "roorkee", "sitarganj"],
  "West Bengal": ["west bengal|wb", "kolkata|calcutta", "howrah", "durgapur", "asansol", "haldia", "siliguri", "raiganj"],
  "Andaman and Nicobar Islands": ["andaman", "nicobar", "port blair", "havelock", "neil island", "campbell bay"],
  Chandigarh: ["chandigarh"],
  "Dadra and Nagar Haveli and Daman and Diu": ["dadra and nagar haveli", "silvassa", "daman", "diu"],
  Delhi: ["delhi", "ncr", "new delhi", "dwarka", "okhla", "bawana"],
  "Jammu and Kashmir": ["jammu and kashmir", "jammu", "srinagar", "\\bj&k\\b", "samba", "kathua", "pulwama", "baramulla"],
  Ladakh: ["ladakh", "leh", "kargil"],
  Lakshadweep: ["lakshadweep", "kavaratti", "minicoy", "agatti"],
  Puducherry: ["puducherry|pondicherry", "karaikal", "yanam", "mahe"],
};

/** returns a Set of official state names that appear in the text by alias/keyword */
function statesMentionedByAliases(text: string): Set<string> {
  const found = new Set<string>();
  if (!text) return found;
  const T = text.toLowerCase();
  for (const [official, aliases] of Object.entries(STATE_ALIASES)) {
    for (const a of aliases) {
      const re = new RegExp(`\\b(${a})\\b`, "i");
      if (re.test(T)) {
        found.add(official);
        break;
      }
    }
  }
  return found;
}

/* =================== MAIN HANDLER =================== */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const window = searchParams.get("window") || "30d";
    const states = (searchParams.get("states") ||
      "Odisha,Andhra Pradesh,Gujarat,Karnataka,Tamil Nadu,Uttar Pradesh,Maharashtra")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const sourceSel =
      ALLOW_QUERY_OVERRIDES
        ? ((searchParams.get("source") || DISCOVERY_SOURCE) as "gnews" | "gdelt" | "both")
        : DISCOVERY_SOURCE;

    const mode: "ai" | "heuristic" =
      ALLOW_QUERY_OVERRIDES
        ? ((searchParams.get("noai") === "1" ? "heuristic" : EXTRACTION_MODE) as any)
        : EXTRACTION_MODE;

    const diag = searchParams.get("diag") === "1";
    const llmdbgParam = searchParams.get("llmdbg") === "1";
    const llmDebugOn = llmdbgParam && mode === "ai";
    const bypass = searchParams.get("bypass") === "1";

    const haveOpenAI = !!process.env.OPENAI_API_KEY;
    if (!haveOpenAI && mode === "ai") {
      return jsonResponse({ error: "Missing OPENAI_API_KEY" }, 500);
    }

    /* ---- 1) Discovery ---- */
    console.log(`[API] Processing ${states.length} states:`, states);
    let gnews: any[] = [];
    let gdelt: any[] = [];
    
    // Process states in batches to avoid timeout issues
    const BATCH_SIZE_STATES = 3; // Process 3 states at a time
    const stateBatches = [];
    for (let i = 0; i < states.length; i += BATCH_SIZE_STATES) {
      stateBatches.push(states.slice(i, i + BATCH_SIZE_STATES));
    }
    
    console.log(`[API] Processing ${stateBatches.length} batches of states`);
    
    if (sourceSel === "gnews" || sourceSel === "both") {
      console.log(`[API] Starting Google News discovery for ${states.length} states in ${stateBatches.length} batches`);
      for (let i = 0; i < stateBatches.length; i++) {
        const batch = stateBatches[i];
        console.log(`[API] Processing Google News batch ${i + 1}/${stateBatches.length}: ${batch.join(', ')}`);
        try {
          const batchResults = await discoverViaGoogleNews(batch, MAX_RECORDS, window);
          gnews = gnews.concat(batchResults);
          console.log(`[API] Batch ${i + 1} found ${batchResults.length} items, total so far: ${gnews.length}`);
        } catch (e) {
          console.error(`[API] Google News batch ${i + 1} failed:`, e);
        }
      }
      console.log(`[API] Google News total found: ${gnews.length} items`);
    }
    
    if (sourceSel === "gdelt" || sourceSel === "both") {
      try {
        console.log(`[API] Starting GDELT discovery for ${states.length} states in ${stateBatches.length} batches`);
        for (let i = 0; i < stateBatches.length; i++) {
          const batch = stateBatches[i];
          console.log(`[API] Processing GDELT batch ${i + 1}/${stateBatches.length}: ${batch.join(', ')}`);
          try {
            const batchResults = await discoverViaGdelt(batch, MAX_RECORDS, window);
            gdelt = gdelt.concat(batchResults);
            console.log(`[API] GDELT batch ${i + 1} found ${batchResults.length} items, total so far: ${gdelt.length}`);
          } catch (e) {
            console.error(`[API] GDELT batch ${i + 1} failed:`, e);
          }
        }
        console.log(`[API] GDELT total found: ${gdelt.length} items`);
      } catch (e) {
        console.error(`[API] GDELT error:`, e);
        gdelt = [];
      }
    }
    
    const discoveredAll = await mergeDiscoveryUnique(gnews, gdelt);
    console.log(`[API] Total discovered: ${discoveredAll.length} items`);

    if (discoveredAll.length === 0) {
      return jsonResponse({
        diag: {
          discovered: 0,
          sourceSel,
          states,
          window,
          note: "discovery-empty (no RSS/GDELT items)",
        },
      });
    }

    // Union all states per URL
    const byUrlUnion = new Map<
      string,
      {
        title: string;
        url: string;
        source: string | null;
        iso_date: string | null;
        tagged_state: string;
        tagged_states: Set<string>;
      }
    >();

    for (const item of discoveredAll) {
      const urlKey = normalizeUrlStrict(item.url);
      const domain = resolveSourceDomain({ url: item.url, source: item.source || null });
      if (!byUrlUnion.has(urlKey)) {
        byUrlUnion.set(urlKey, {
          title: item.title || "",
          url: item.url,
          source: domain,
          iso_date: item.iso_date ?? null,
          tagged_state: item.tagged_state,
          tagged_states: new Set([item.tagged_state]),
        });
      } else {
        byUrlUnion.get(urlKey)!.tagged_states.add(item.tagged_state);
      }
    }

    const discoveredUnique = Array.from(byUrlUnion.values()).map((x) => ({
      title: x.title,
      url: x.url,
      source: x.source,
      iso_date: x.iso_date,
      tagged_state: x.tagged_state,
      tagged_states: Array.from(x.tagged_states),
    }));

    /* ---- 2) Fetch HTML → text ---- */
    const itemsWithText: DiscoveredWithText[] = await Promise.all(
      discoveredUnique.map(async (a) => {
        try {
          const res = await fetch(a.url, { headers: { "User-Agent": "Mozilla/5.0" } });
          const html = await res.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/g, " ")
            .replace(/<style[\s\S]*?<\/style>/g, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 20000);
          return { ...a, text };
        } catch {
          return { ...a, text: "" };
        }
      })
    );

    // helper maps
    const pageTextByUrl = new Map<string, string>();
    const titleByUrl = new Map<string, string>();
    const statesByUrl = new Map<string, string[]>();
    const amountHintByUrl = new Map<string, number>();
    for (const it of itemsWithText) {
      const key = normalizeUrlStrict(it.url);
      const txt = `${it.title || ""} ${it.text || ""}`;
      pageTextByUrl.set(key, txt);
      titleByUrl.set(key, it.title || "");
      statesByUrl.set(key, it.tagged_states || [it.tagged_state].filter(Boolean));
      const hint = maxInrAmountCrore(txt);
      if (hint && hint > 0) amountHintByUrl.set(key, hint);
    }

    /* ---- 2b) HARD publisher whitelist ---- */
    let itemsAfterWhitelist = itemsWithText;
    let droppedByWhitelist = 0;
    if (AI_WHITELIST_MODE === "hard") {
      itemsAfterWhitelist = itemsWithText.filter((it) => isWhitelistedDomain(it.source));
      droppedByWhitelist = itemsWithText.length - itemsAfterWhitelist.length;
      if (itemsAfterWhitelist.length === 0) {
        return jsonResponse({
          diag: {
            discovered: discoveredAll.length,
            droppedByWhitelist,
            whitelistMode: AI_WHITELIST_MODE,
            final: 0,
          },
          sample: [],
        });
      }
    }

    /* ---- 3) Relevance + category (no early state filter) ---- */
    const withRel = itemsAfterWhitelist.map((it) => {
      const rel = relevanceScore(it.title || "", it.text || "");
      const cat = classifyInvestmentCategory(it.title || "", it.text || "");
      return { ...it, __rel: rel, __cat: cat };
    });

    const minRel = 1;
    let itemsForExtraction = withRel.filter(
      (x) => x.__rel.score >= minRel && ALLOWED_CATS.has(x.__cat || "")
    );

    if (itemsForExtraction.length === 0) {
      const eligible = withRel.filter((x) => ALLOWED_CATS.has(x.__cat || ""));
      itemsForExtraction = [...eligible]
        .sort((a, b) => b.__rel.score - a.__rel.score)
        .slice(0, Math.min(50, eligible.length)); // Increased from 25 to 50
    }

    const aiItems =
      AI_WHITELIST_MODE === "ai"
        ? itemsForExtraction.filter((it) => isWhitelistedDomain(it.source))
        : itemsForExtraction;

    if (llmDebugOn) {
      const sample = aiItems.slice(0, Math.min(BATCH_SIZE, 6));
      const prompt = buildPromptPreview(sample as any);
      return jsonResponse({
        whitelistMode: AI_WHITELIST_MODE,
        droppedByWhitelist,
        aiItems_count: aiItems.length,
        prompt_preview: prompt.slice(0, 12000),
      });
    }

    /* ---- 4) Extract with OpenAI (or heuristic fallback) ---- */
    let extractedFlat: any[] = [];
    const skipAI = mode !== "ai" || aiItems.length === 0;

    if (!skipAI) {
      try {
        const batches: any[][] = [];
        for (let i = 0; i < aiItems.length; i += BATCH_SIZE) {
          batches.push(aiItems.slice(i, i + BATCH_SIZE));
        }
        const extractedArrays = await Promise.all(
          batches.map(async (batch) => {
            try {
              return await extractStructured(batch as any);
            } catch {
              return [];
            }
          })
        );
        extractedFlat = extractedArrays.flat();
      } catch {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const batches: any[][] = [];
          for (let i = 0; i < aiItems.length; i += BATCH_SIZE) {
            batches.push(aiItems.slice(i, i + BATCH_SIZE));
          }
          const extractedArrays = await Promise.all(
            batches.map(async (batch) => {
              try {
                return await extractStructured(batch as any);
              } catch {
                return [];
              }
            })
          );
          extractedFlat = extractedArrays.flat();
        } catch {
          extractedFlat = [];
        }
      }
    }

    /* ---- 5) Build records, boost, then fan-out per URL’s states/aliases ---- */
    let records: Investment[];

    const byUrlItem = new Map<string, DiscoveredWithText>(
      aiItems.map((it) => [normalizeUrlStrict(it.url), it])
    );
    const byUrlAny = new Map<string, DiscoveredWithText>(
      itemsAfterWhitelist.map((it) => [normalizeUrlStrict(it.url), it])
    );

    const selectedSet = new Set(states.map(normStrict));

    if (skipAI || extractedFlat.length === 0) {
      const baseSet = itemsForExtraction;
      if (baseSet.length === 0) {
        if (bypass) {
          const fallback = itemsAfterWhitelist.slice(0, 30).map((a) =>
            toInvestment({
              company: null,
              sector: null,
              amount_in_inr_crore: null,
              jobs: null,
              state: a.tagged_state || null,
              district: null,
              project_type: /mou/i.test(a.title || "")
                ? "MoU"
                : /expansion/i.test(a.title || "")
                ? "Expansion"
                : null,
              status: /mou/i.test(a.title || "") ? "MoU" : "Announced",
              announcement_date: a.iso_date || null,
              source_url: a.url,
              source_name: a.source || null,
              opportunity_score: 0,
              rationale: "Discovery-only bypass (bypass=1)",
            })
          );
          const fanned = fallback.flatMap((r) => {
            const key = normalizeUrlStrict(r.source_url);
            const txt = pageTextByUrl.get(key) || "";
            const aliasStates = Array.from(statesMentionedByAliases(txt));
            const discoveredStates = statesByUrl.get(key) || [];
            const unionStates = new Set<string>([...discoveredStates, ...aliasStates]);
            const candidates = Array.from(unionStates).filter((st) => selectedSet.has(normStrict(st)));
            let finalStates = candidates;
            if (finalStates.length === 0) {
              const single = discoveredStates.find((st) => selectedSet.has(normStrict(st)));
              if (single) finalStates = [single];
            }
            if (finalStates.length === 0) return [] as Investment[];
            return finalStates.map((st) => ({ ...r, state: st }));
          });
          return jsonResponse(fanned);
        }
        return jsonResponse([]);
      }

      const heuristicRows: Investment[] = baseSet.map((a) =>
        toInvestment(
          enrichFromHeuristics(a, {
            company: null,
            sector: null,
            amount_in_inr_crore: null,
            jobs: null,
            state: a.tagged_state || null,
            district: null,
            project_type: /mou/i.test(a.title || "")
              ? "MoU"
              : /expansion/i.test(a.title || "")
              ? "Expansion"
              : null,
            status: /mou/i.test(a.title || "") ? "MoU" : "Announced",
            announcement_date: a.iso_date || null,
            source_url: a.url,
            source_name: a.source || null,
            opportunity_score: 0,
            rationale:
              mode !== "ai"
                ? "Heuristic (EXTRACTION_MODE=heuristic)"
                : aiItems.length === 0
                ? (AI_WHITELIST_MODE === "ai"
                    ? "Heuristic (AI skipped: source not in AI whitelist)"
                    : "Heuristic (AI skipped)")
                : "Heuristic (auto fallback: empty AI result)",
          })
        )
      );

      const byUrl = new Map<string, any>(baseSet.map((it) => [normalizeUrlStrict(it.url), it]));
      const boosted = await boostMissing(byUrl, heuristicRows, 10);

      // Fan-out per URL by discovered states + aliases; intersect with user selection
      records = boosted.flatMap((r) => {
        const key = normalizeUrlStrict(r.source_url);
        const txt = pageTextByUrl.get(key) || "";
        const aliasStates = Array.from(statesMentionedByAliases(txt));
        const discoveredStates = statesByUrl.get(key) || [];
        const unionStates = new Set<string>([...discoveredStates, ...aliasStates]);
        const candidates = Array.from(unionStates).filter((st) => selectedSet.has(normStrict(st)));
        let finalStates = candidates;
        if (finalStates.length === 0) {
          const single = discoveredStates.find((st) => selectedSet.has(normStrict(st)));
          if (single) finalStates = [single];
        }
        if (finalStates.length === 0) return [] as Investment[];
        return finalStates.map((st) => ({ ...r, state: st }));
      });
    } else {
      const discMap = new Map<string, DiscoveredWithText>(
        aiItems.map((it) => [normalizeUrlStrict(it.url), it])
      );

      const enriched = extractedFlat
        .map((x: any) => {
          const d =
            discMap.get(normalizeUrlStrict(x.source_url)) ||
            byUrlAny.get(normalizeUrlStrict(x.source_url)) ||
            ({} as any);
          return toInvestment(enrichFromHeuristics(d, x));
        })
        .filter((r: Investment) => !!r.source_url);

      const byUrl = new Map<string, any>(aiItems.map((it) => [normalizeUrlStrict(it.url), it]));
      const boosted = await boostMissing(byUrl, enriched, 10);

      records = boosted.flatMap((r) => {
        const key = normalizeUrlStrict(r.source_url);
        const txt = pageTextByUrl.get(key) || "";
        const aliasStates = Array.from(statesMentionedByAliases(txt));
        const discoveredStates = statesByUrl.get(key) || [];
        const unionStates = new Set<string>([...discoveredStates, ...aliasStates]);
        const candidates = Array.from(unionStates).filter((st) => selectedSet.has(normStrict(st)));
        let finalStates = candidates;
        if (finalStates.length === 0) {
          const single = discoveredStates.find((st) => selectedSet.has(normStrict(st)));
          if (single) finalStates = [single];
        }
        if (finalStates.length === 0) return [] as Investment[];
        return finalStates.map((st) => ({ ...r, state: st }));
      });
    }

    /* ---- 6) Amount repair, Govt/PSU tagging, sector/company fixes ---- */
    records = records.map((r) => ({
      ...r,
      amount_in_inr_crore:
        typeof r.amount_in_inr_crore === "number" && r.amount_in_inr_crore > 0
          ? r.amount_in_inr_crore
          : null,
    }));

    records = records.map((r) => {
      const key = normalizeUrlStrict(r.source_url);
      const hint = amountHintByUrl.get(key);
      if (!hint) return r;
      const cur = typeof r.amount_in_inr_crore === "number" ? r.amount_in_inr_crore : null;
      if (cur == null || cur < 0.6 * hint) {
        return {
          ...r,
          amount_in_inr_crore: hint,
          rationale: r.rationale
            ? `${r.rationale}; amount fixed from page text`
            : "Amount fixed from page text",
        };
      }
      return r;
    });

    records = await Promise.all(
      records.map(async (r) => {
        const key = normalizeUrlStrict(r.source_url);
        const text = pageTextByUrl.get(key) || "";
        const current = r.company;

        const psu = detectPSUName(text);
        if ((!current || isGenericCompanyName(current)) && psu) {
          return {
            ...r,
            company: psu,
            rationale: r.rationale
              ? `${r.rationale}; tagged as PSU (${psu})`
              : `Tagged as PSU (${psu})`,
          };
        }
        if ((!current || isGenericCompanyName(current)) && textHasAny(text, CENTRAL_HINTS)) {
          return {
            ...r,
            company: "Central Government",
            rationale: r.rationale
              ? `${r.rationale}; tagged as Central Government project`
              : "Tagged as Central Government project",
          };
        }
        if ((!current || isGenericCompanyName(current)) && textHasAny(text, STATE_HINTS) && r.state) {
          const stateGovt =
            /^Delhi$/i.test(r.state) ? "Government of NCT of Delhi" : `Government of ${r.state}`;
          return {
            ...r,
            company: stateGovt,
            rationale: r.rationale ? `${r.rationale}; tagged as ${stateGovt}` : `Tagged as ${stateGovt}`,
          };
        }

        // Repair + sector refine + company canonicalize
        const repaired = repairWeirdAI(r, text);
        const refined = refineSector(repaired, text);
        const title = titleByUrl.get(key) || "";
        const { company, note } = await canonicalizeCompany(refined.company, text, title);
        if (company && company !== refined.company) {
          return {
            ...refined,
            company,
            rationale: refined.rationale
              ? `${refined.rationale}; ${note || "company canonicalized"}`
              : (note || "company canonicalized"),
          };
        }
        return refined;
      })
    );

    /* ---- 7) Normalize → score → DEDUPE (State+Amount+Date±1) ---- */
    const normalized = normalizeRecords(records);
    const scored = scoreRecords(normalized);
    const deduped = dedupeByStateAmountDate(scored);
    
    // Track deduplication stats
    const duplicatesRemoved = scored.length - deduped.length;

    /* ---- 8) Final filter: ensure state ∈ selected ---- */
    const selectedSetFinal = new Set(states.map(normStrict));
    const final = deduped.filter((r) => r.state && selectedSetFinal.has(normStrict(r.state)));

    if (diag) {
      return jsonResponse({
        diag: {
          discovered: discoveredAll.length,
          discoveredUnique: discoveredUnique.length,
          statesRequested: states.length,
          statesList: states,
          gnewsCount: gnews.length,
          gdeltCount: gdelt.length,
          afterExtraction: records.length,
          afterDedupe: deduped.length,
          duplicatesRemoved,
          final: final.length,
          verificationEnabled: true,
        },
        sample: final.slice(0, 3),
        verification: {
          note: "Content verification is now enabled to prevent AI hallucinations",
          checks: [
            "Company names must appear verbatim in article text",
            "States must be explicitly mentioned in article content", 
            "Sectors must be supported by keywords in article text",
            "Amounts must be explicitly mentioned with numbers"
          ]
        }
      });
    }

    if (final.length === 0 && bypass) {
      const fallback = itemsAfterWhitelist.slice(0, 30).map((a) =>
        toInvestment({
          company: null,
          sector: null,
          amount_in_inr_crore: null,
          jobs: null,
          state: a.tagged_state || null,
          district: null,
          project_type: /mou/i.test(a.title || "")
            ? "MoU"
            : /expansion/i.test(a.title || "")
            ? "Expansion"
            : null,
          status: /mou/i.test(a.title || "") ? "MoU" : "Announced",
          announcement_date: a.iso_date || null,
          source_url: a.url,
          source_name: a.source || null,
          opportunity_score: 0,
          rationale: "Discovery-only bypass (bypass=1)",
        })
      );
      return jsonResponse(fallback);
    }

    return jsonResponse(final);
  } catch (e: any) {
    console.error("❌ /api/investments error:", e);
    return jsonResponse({ error: e?.message || String(e) }, 500);
  }
}
