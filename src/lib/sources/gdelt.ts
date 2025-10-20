import { normalizeUrl } from "@/lib/dedupe";

export type Discovered = {
  title: string;
  url: string;
  publishedAt?: string;
  source?: string | null;
  text?: string;
  tagged_state?: string;    // which state the query was for
  iso_date?: string | null; // YYYY-MM-DD
  __gdelt_note?: string;    // optional diag when GDELT errors
};

// Must contain at least one of these to be considered at discovery-time
const POS_WORDS =
  /(invest|investment|fdi|capex|crore|cr|plant|factory|unit|manufactur|facility|park|sez|industrial|cluster|greenfield|brownfield|expansion|commissioned|jobs|employment|semiconductor|chip|pcb|ev|battery|steel|cement|refinery|petrochem|chemical|textile|pharma|biotech|solar|module|ingot|wafer)/i;

// Drop obvious non-investment political/education items early
const NEG_TITLES =
  /(cabinet expansion|cabinet reshuffle|election|polls|politics|minister sworn|unesco|ncert|school|teacher education|curriculum|students|festival|religion)/i;

function toISODate(s?: string): string | null {
  if (!s) return null;
  const m = s.match(/(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Fetch helper that tolerates GDELT's plain-text error messages */
async function fetchGdeltJson(url: string): Promise<{ ok: boolean; json?: any; note?: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await res.text(); // read as text first
    try {
      const j = JSON.parse(text);
      return { ok: true, json: j };
    } catch {
      return { ok: false, note: (text || "").slice(0, 300) };
    }
  } catch (e: any) {
    return { ok: false, note: e?.message || String(e) };
  }
}

/**
 * Discover recent, India-focused investment articles via GDELT.
 * We query once per state, tag results with that state, then filter & dedupe.
 */
export async function discoverViaGdelt(
  states: string[],
  maxRecords = 60,
  window = "30d" // e.g., "7d", "30d"
): Promise<Discovered[]> {
  // OR-only term block (allowed to use parentheses)
  const OR_BLOCK =
    '("investment" OR invest OR FDI OR capex OR crore OR cr OR plant OR factory OR unit OR manufacturing OR greenfield OR brownfield OR expansion)';

  const calls = states.map((rawState) => {
    // Quote the state (important for multi-word names)
    const stateQuoted = `"${rawState}"`;

    // IMPORTANT: No outer parentheses around the AND expression.
    // GDELT only allows parentheses around OR’d statements.
    const q = `${OR_BLOCK} AND ${stateQuoted} AND sourceCountry:IN`;

    const url =
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}` +
      `&timespan=${encodeURIComponent(window)}` +
      `&maxrecords=${Math.min(maxRecords, 70)}&format=json`;
    return { state: rawState, url, q };
  });

  const results = await Promise.all(
    calls.map(async (c) => {
      const got = await fetchGdeltJson(c.url);
      return { got, state: c.state, url: c.url, q: c.q };
    })
  );
  console.log('results ',results);
  
  const items = results.flatMap((r) => {
    if (!r.got.ok) {
      // If GDELT returned a text error, just skip (no crash) — optionally expose a diag stub
      return [
        {
          title: "",
          url: "",
          publishedAt: undefined,
          iso_date: null,
          source: null,
          tagged_state: r.state,
          __gdelt_note: `GDELT_ERROR: ${r.got.note || "unknown"} | q=${r.q}`
        } as Discovered,
      ];
    }

    const j: any = r.got.json;
    const state = r.state;
    const docs = j?.articles || j?.docs || [];

    return docs.map((a: any) => {
      const url = a.url || a.urlArticle || a.sourceUrl || "";
      const title = a.title || a.semtag || "";
      const publishedAt = a.seendate || a.publishtime || a.publishedAt;

      return {
        title,
        url,
        publishedAt,
        iso_date: toISODate(publishedAt),
        source: a.sourceDomain || a.domain || a.source || null,
        tagged_state: state,
      } as Discovered;
    });
  });

  // Filter out diagnostic stubs from failed states (no URL/title)
  const onlyReal = items.filter((it) => it.url && it.title);

  // Dedupe by normalized URL (same story can appear for multiple state queries)
  const seen = new Set<string>();
  const unique = onlyReal.filter((it) => {
    const key = normalizeUrl(it.url);
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Title-level filters: must have a positive keyword and not match negative patterns
  return unique
    .filter((a) => POS_WORDS.test(`${a.title}`))
    .filter((a) => !NEG_TITLES.test(`${a.title}`))
    .slice(0, maxRecords);
}
