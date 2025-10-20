// src/app/api/investments/route.ts

import type { Investment } from "@/lib/types";

// Discovery (your existing implementations)
import { discoverViaGdelt } from "@/lib/sources/gdelt";
import { discoverViaGoogleNews, mergeDiscoveryUnique } from "@/lib/sources/googleNews";

// LLM extraction
import { extractStructured, buildPromptPreview } from "@/lib/extract";

// Pipeline utils (use your existing ones)
import { normalizeRecords } from "@/lib/normalize";
import { scoreRecords } from "@/lib/score";
import { enrichFromHeuristics, toInvestment } from "@/lib/enrich";
import { boostMissing } from "@/lib/boost";
import { dedupeRecordsSmart, normalizeUrl } from "@/lib/dedupe";
import { relevanceScore, classifyInvestmentCategory } from "@/lib/relevance";
import { maxInrAmountCrore } from "@/lib/amount";
import { isExplicitForState } from "@/lib/geo";

export const runtime = "nodejs";

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

const MAX_RECORDS = 60;
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

  // 1) Foxconn/Hon Hai normalization
  if (/\b(foxconn|hon hai)\b/i.test(text) || /\b(foxconn|hon hai)\b/i.test(out.company || "")) {
    out.company = "Foxconn (Hon Hai Precision Industry)";
    const isAuto = /\b(car|vehicle|ev|two[- ]wheeler|scooter|bus|truck|oem|automobile)\b/i.test(text);
    const isSemi = /\b(semiconductor|chip|fab|foundry|atmp|osat|wafer)\b/i.test(text);
    out.sector = isAuto ? "Automobile" : (isSemi ? "Semiconductor" : "Electronics/EMS");
  }

  // 2) If company doesn't appear in article text (and not government/PSU), clear it
  if (out.company) {
    const re = new RegExp(`\\b${escapeRegExp(out.company)}\\b`, "i");
    const isGovt =
      /\b(government|govt|ministry|department|authority|board|corporation|council|psu)\b/i.test(out.company);
    if (!re.test(text) && !isGovt) {
      out.rationale = (out.rationale ? out.rationale + "; " : "") + "company cleared (not found in article text)";
      out.company = null;
    }
  }

  // 3) Sector repair to avoid false 'Automobile'
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

/* ---------------- Types for local flow ---------------------- */
type DiscoveredWithText = {
  title: string;
  url: string;
  source: string | null;   // normalized domain
  iso_date: string | null; // YYYY-MM-DD
  tagged_state: string;
  text: string;            // ALWAYS present ("" if fetch failed)
  __rel?: any;
  __cat?: string;
  __state_ok?: boolean;
};

/* ---------- STRICT de-duplication: State + Company + Amount (exact) ---------- */

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

function normStrict(s?: string | null): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countFilledFields(r: Investment): number {
  const fields: Array<keyof Investment> = [
    "company","sector","amount_in_inr_crore","jobs","state","district","project_type","status","announcement_date"
  ];
  return fields.reduce((n, k) => n + ((r as any)[k] != null ? 1 : 0), 0);
}

function chooseBestRecord(a: Investment, b: Investment): Investment {
  // rank by: source priority (lower is better), more filled fields, higher amount, newer date
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

  return a; // stable default
}

function tripleKey(rec: Investment): string | null {
  const st = normStrict(rec.state);
  const co = normStrict(rec.company);
  const amt = rec.amount_in_inr_crore;
  if (!st || !co || amt == null || !Number.isFinite(amt)) return null;

  // exact (integer) crore key as requested
  const amtInt = Math.round(Number(amt));
  return `${st}|${co}|${amtInt}`;
}

function dedupeByStateCompanyAmount(rows: Investment[]): Investment[] {
  const byKey = new Map<string, Investment>();
  const passThrough: Investment[] = [];

  for (const r of rows) {
    const key = tripleKey(r);
    if (!key) {
      passThrough.push(r);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
    } else {
      byKey.set(key, chooseBestRecord(existing, r));
    }
  }

  // preserve input order for winners, then passthroughs (no key)
  const winnersSet = new Set(byKey.values());
  const ordered: Investment[] = [];
  const seen = new Set<Investment>();

  for (const r of rows) {
    const key = tripleKey(r);
    if (key) {
      const w = byKey.get(key)!;
      if (!seen.has(w)) {
        ordered.push(w);
        seen.add(w);
      }
    }
  }
  for (const r of passThrough) {
    if (!seen.has(r)) {
      ordered.push(r);
      seen.add(r);
    }
  }
  return ordered;
}

/* ------------------------ Handler --------------------------- */
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
    let gnews: any[] = [];
    let gdelt: any[] = [];
    if (sourceSel === "gnews" || sourceSel === "both") {
      gnews = await discoverViaGoogleNews(states, MAX_RECORDS, window);
    }
    if (sourceSel === "gdelt" || sourceSel === "both") {
      try {
        gdelt = await discoverViaGdelt(states, MAX_RECORDS, window);
      } catch {
        gdelt = [];
      }
    }
    const discovered = await mergeDiscoveryUnique(gnews, gdelt);

    if (discovered.length === 0) {
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

    const titleByUrl = new Map<string, string>();
    for (const it of discovered) titleByUrl.set(normalizeUrl(it.url), it.title || "");

    /* ---- 2) Fetch article HTML → plain text ---- */
    const itemsWithText: DiscoveredWithText[] = await Promise.all(
      discovered.map(async (a) => {
        const domain = resolveSourceDomain({ url: a.url, source: a.source || null });
        try {
          const res = await fetch(a.url, { headers: { "User-Agent": "Mozilla/5.0" } });
          const html = await res.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/g, " ")
            .replace(/<style[\s\S]*?<\/style>/g, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 20000);
          return {
            title: a.title,
            url: a.url,
            source: domain,
            iso_date: a.iso_date ?? null,
            tagged_state: a.tagged_state,
            text,
          };
        } catch {
          return {
            title: a.title,
            url: a.url,
            source: domain,
            iso_date: a.iso_date ?? null,
            tagged_state: a.tagged_state,
            text: "",
          };
        }
      })
    );

    // helper maps
    const pageTextByUrl = new Map<string, string>();
    const amountHintByUrl = new Map<string, number>();
    for (const it of itemsWithText) {
      const key = normalizeUrl(it.url);
      const txt = `${it.title || ""} ${it.text || ""}`;
      pageTextByUrl.set(key, txt);
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
            discovered: discovered.length,
            droppedByWhitelist,
            whitelistMode: AI_WHITELIST_MODE,
            final: 0,
          },
          sample: [],
        });
      }
    }

    /* ---- 3) Relevance + category + explicit state check ---- */
    const withRel = itemsAfterWhitelist.map((it) => {
      const rel = relevanceScore(it.title || "", it.text || "");
      const cat = classifyInvestmentCategory(it.title || "", it.text || "");
      const stateOk =
        !!it.tagged_state &&
        isExplicitForState(`${it.title || ""} ${it.text || ""}`, it.tagged_state);
      return { ...it, __rel: rel, __cat: cat, __state_ok: stateOk };
    });

    const minRel = 1;
    let itemsForExtraction = withRel.filter(
      (x) => x.__rel.score >= minRel && x.__state_ok && ALLOWED_CATS.has(x.__cat || "")
    );
    if (itemsForExtraction.length === 0) {
      const eligible = withRel.filter((x) => x.__state_ok && ALLOWED_CATS.has(x.__cat || ""));
      itemsForExtraction = [...eligible]
        .sort((a, b) => b.__rel.score - a.__rel.score)
        .slice(0, Math.min(25, eligible.length));
    }

    // AI-only whitelist (if not already hard-filtered)
    const aiItems =
      AI_WHITELIST_MODE === "ai"
        ? itemsForExtraction.filter((it) => isWhitelistedDomain(it.source))
        : itemsForExtraction;

    /* ---- LLM debug (optional) ---- */
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
        // retry once
        await new Promise((r) => setTimeout(r, 1000));
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

    /* ---- 5) Build records (heuristic path if AI skipped/empty) ---- */
    let records: Investment[];

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
          return jsonResponse(fallback);
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

      const byUrl = new Map<string, any>(baseSet.map((it) => [it.url, it]));
      records = await boostMissing(byUrl, heuristicRows, 10);
    } else {
      const discMap = new Map<string, DiscoveredWithText>();
      for (const it of aiItems) discMap.set(it.url, it);

      const enriched = extractedFlat
        .map((x: any) => {
          const d = discMap.get(x.source_url) || ({} as any);
          return toInvestment(enrichFromHeuristics(d, x));
        })
        .filter((r: Investment) => !!r.source_url);

      const byUrl = new Map<string, any>(aiItems.map((it) => [it.url, it]));
      records = await boostMissing(byUrl, enriched, 10);
    }

    /* ---- 6) Amount repair & Govt/PSU tagging ---- */
    // (a) invalid amounts → null
    records = records.map((r) => ({
      ...r,
      amount_in_inr_crore:
        typeof r.amount_in_inr_crore === "number" && r.amount_in_inr_crore > 0
          ? r.amount_in_inr_crore
          : null,
    }));

    // (b) repair from page hints
    records = records.map((r) => {
      const key = normalizeUrl(r.source_url);
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

    // (c) tag PSU / Central / State Govt
    records = records.map((r) => {
      const key = normalizeUrl(r.source_url);
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

      return r;
    });

    // (d) final weird-AI repair pass (company presence + sector sanity)
    records = records.map((r) => {
      const key = normalizeUrl(r.source_url);
      const text = pageTextByUrl.get(key) || "";
      return repairWeirdAI(r, text);
    });

    /* ---- 7) Normalize → score → dedupe ---- */
    const normalized = normalizeRecords(records);
    const scored = scoreRecords(normalized);

    // First pass: collapse trivial duplicates (URL/title similarity)
    const firstPass = dedupeRecordsSmart(scored, titleByUrl);

    // Second pass: STRICT dedupe by exact State+Company+Amount
    const deduped = dedupeByStateCompanyAmount(firstPass);

    /* ---- 8) Final filter: ensure state ∈ selected ---- */
    const selectedSet = new Set(states);
    const final = deduped.filter((r) => r.state && selectedSet.has(r.state));

    if (diag) {
      return jsonResponse({
        diag: {
          discovered: discovered.length,
          mode,
          sourceSel,
          whitelistMode: AI_WHITELIST_MODE,
          used_ai: !(mode !== "ai" || (aiItems?.length ?? 0) === 0),
          after_first_pass: firstPass.length,
          final: final.length,
        },
        sample: final.slice(0, 3),
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
