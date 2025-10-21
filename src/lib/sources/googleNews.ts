// src/lib/sources/googleNews.ts
// Robust Google News RSS discovery (India locale) with optional strict filtering.

type DiscoveredItem = {
  title: string;
  url: string;
  source: string | null;     // domain (e.g., economictimes.indiatimes.com)
  iso_date: string | null;   // YYYY-MM-DD
  tagged_state: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// Env toggles (string "1" enables)
const GNEWS_STRICT = process.env.GNEWS_STRICT === "1";     // when off (default), DO NOT filter headlines
const GNEWS_DIAG = process.env.GNEWS_DIAG === "1";         // logs to server console

function toDays(windowStr: string): number {
  const m = windowStr.match(/^(\d+)\s*d$/i);
  return m ? Math.max(1, Math.min(90, parseInt(m[1], 10))) : 30;
}

function buildQuery(state: string, days: number): string {
  // Broad keywords. Keep very broad to ensure discovery returns items;
  // later stages (relevance/category) will filter noise.
  const kw =
    '(investment OR invest OR FDI OR capex OR "crore" OR "Rs" OR plant OR factory OR unit OR manufacturing OR greenfield OR brownfield OR expansion OR MoU OR "memorandum of understanding" OR "industrial park" OR "data centre" OR "data center" OR SEZ OR cluster OR corridor)';
  return encodeURIComponent(`${kw} "${state}" when:${days}d`);
}

function buildGNewsUrl(state: string, windowStr: string): string {
  const days = toDays(windowStr);
  const q = buildQuery(state, days);
  return `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
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

// Try to unwrap Google News redirects to the publisher URL
function unwrapGoogleNewsLink(link: string): string {
  try {
    const u = new URL(link);
    if (u.hostname.endsWith("news.google.com")) {
      // URL param occasionally present
      const actual = u.searchParams.get("url");
      if (actual) return actual;
      // Some feeds use "iurl" or "ved"-style; if missing, leave as-is
      return link;
    }
    return link;
  } catch {
    return link;
  }
}

function parseRssItems(xml: string): Array<{ title: string; link: string; pubDate: string; source?: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; source?: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
      .trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "").trim();
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] || "")
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
      .trim();
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

function toIsoDate(d: string | undefined | null): string | null {
  if (!d) return null;
  const dt = new Date(d);
  if (!isFinite(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

// Optional strict title filter (disable by default to avoid empty discovery)
function likelyInvestmentTitle(t: string): boolean {
  const s = t.toLowerCase();
  if (/\b(election|cabinet reshuffle|politics|minister oath|campaign)\b/i.test(s)) return false;
  return /\b(invest|fdi|capex|crore|plant|factory|unit|manufactur|greenfield|brownfield|expansion|mou|memorandum|industrial park|data centre|data center|sez|cluster|corridor)\b/i.test(
    s
  );
}

export async function discoverViaGoogleNews(
  states: string[],
  maxRecords: number,
  windowStr: string
): Promise<DiscoveredItem[]> {
  const out: DiscoveredItem[] = [];
  // Fixed: Use a reasonable per-state cap instead of dividing by state count
  // This ensures we get good coverage for each state regardless of how many are selected
  const perStateCap = Math.max(15, Math.min(25, Math.floor(maxRecords / 2)));
  
  console.log(`[GNews] Processing ${states.length} states with perStateCap=${perStateCap}`);

  for (const state of states) {
    console.log(`[GNews] Processing state: ${state}`);
    const url = buildGNewsUrl(state, windowStr);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,text/xml,*/*" } });
      const xml = await res.text();

      const items = parseRssItems(xml);

      // Keep discovery broad unless GNEWS_STRICT=1 is set
      const filtered = (GNEWS_STRICT ? items.filter((it) => likelyInvestmentTitle(it.title)) : items)
        .slice(0, perStateCap);

      console.log(`[GNews] State ${state}: total=${items.length} kept=${filtered.length} perStateCap=${perStateCap}`);

      for (const it of filtered) {
        const realUrl = unwrapGoogleNewsLink(it.link);
        const domain = cleanHost(realUrl);
        out.push({
          title: it.title,
          url: realUrl,
          source: domain,
          iso_date: toIsoDate(it.pubDate),
          tagged_state: state,
        });
      }
    } catch (e: any) {
      console.error(`[GNews] fetch failed for state=${state}:`, e?.message || e);
    }
  }

  return dedupeByUrl(out);
}

function dedupeByUrl(rows: DiscoveredItem[]): DiscoveredItem[] {
  const seen = new Set<string>();
  const out: DiscoveredItem[] = [];
  for (const it of rows) {
    const key = normalizeUrl(it.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Merge two discovery arrays and de-duplicate by normalized URL.
 */
export function mergeDiscoveryUnique(a: DiscoveredItem[], b: DiscoveredItem[]): DiscoveredItem[] {
  const seen = new Set<string>();
  const all = [...a, ...b];
  const out: DiscoveredItem[] = [];
  for (const it of all) {
    const key = normalizeUrl(it.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// Local copy: normalizeUrl (avoid circular import)
function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    const qs = url.searchParams.toString();
    const core = `${host}${path}${qs ? "?" + qs : ""}`;
    return core.toLowerCase();
  } catch {
    return (u || "").trim().toLowerCase();
  }
}
