// src/lib/dedupe.ts
import type { Investment } from "@/lib/types";

export type AnyRow = Record<string, any>;

/**
 * Normalize a URL for stable comparisons (strip protocol, www, trailing slash, anchors).
 */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    // ignore query strings for deduplication
    return `${host}${path}`.toLowerCase();
  } catch {
    return (u || "").trim().toLowerCase();
  }
}

function normTitle(t?: string | null): string {
  return (t || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Smart-ish de-duplication for Investment rows (existing logic kept).
 * - Collapse items with identical normalized URLs.
 * - Also collapse near-duplicate titles (same normalized title) keeping the "better" record:
 *   preference order: higher amount, then has company, then higher opportunity_score, then newer date.
 */
export function dedupeRecordsSmart(
  rows: Investment[],
  titleByUrl: Map<string, string>
): Investment[] {
  const byUrl = new Map<string, Investment>();
  for (const r of rows) {
    const key = normalizeUrl(r.source_url);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, r);
      continue;
    }
    const prevAmt = prev.amount_in_inr_crore ?? 0;
    const curAmt = r.amount_in_inr_crore ?? 0;
    if (curAmt > prevAmt) {
      byUrl.set(key, r);
    } else if (curAmt === prevAmt) {
      if (r.opportunity_score > prev.opportunity_score) byUrl.set(key, r);
    }
  }
  const urlCollapsed = Array.from(byUrl.values());

  const byTitle = new Map<string, Investment>();
  for (const r of urlCollapsed) {
    const t = titleByUrl.get(normalizeUrl(r.source_url)) ?? "";
    const nt = normTitle(t);
    if (!nt) {
      if (!byTitle.has(r.source_url)) byTitle.set(r.source_url, r);
      continue;
    }
    const prev = byTitle.get(nt);
    if (!prev) {
      byTitle.set(nt, r);
      continue;
    }
    const prevAmt = prev.amount_in_inr_crore ?? 0;
    const curAmt = r.amount_in_inr_crore ?? 0;
    if (curAmt > prevAmt) {
      byTitle.set(nt, r);
    } else if (curAmt === prevAmt) {
      if ((r.company ? 1 : 0) > (prev.company ? 1 : 0)) byTitle.set(nt, r);
      else if (r.opportunity_score > prev.opportunity_score) byTitle.set(nt, r);
      else {
        const pDate = prev.announcement_date ? Date.parse(prev.announcement_date) : 0;
        const cDate = r.announcement_date ? Date.parse(r.announcement_date) : 0;
        if (cDate > pDate) byTitle.set(nt, r);
      }
    }
  }

  return Array.from(byTitle.values());
}

/**
 * Deterministic, generic key-based dedupe for small structured rows (company|amount|state|date).
 * Keeps first record and merges missing fields from subsequent duplicates.
 */
export function dedupeByKey(items: AnyRow[]): AnyRow[] {
  const map = new Map<string, AnyRow>();
  let unknownCounter = 0;

  const normalize = (s?: any) =>
    (s == null ? "" : String(s)).toString().toLowerCase().replace(/[^\w\s]/g, "").trim();

  const normalizeAmount = (a?: any) => {
    if (a == null || a === "") return "";
    const s = String(a).replace(/[,\s₹$€£]/g, "");
    const n = Number(s);
    if (Number.isFinite(n)) return String(Math.round(n));
    return normalize(a);
  };

  const canonicalDate = (d?: any) => {
    if (!d) return "";
    const dt = new Date(String(d));
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
    const m = String(d).match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : normalize(d);
  };

  for (const it of items) {
    const key = [
      normalize(it.company),
      normalizeAmount(it.amount_in_inr_crore ?? it.amount),
      normalize(it.state),
      canonicalDate(it.announcement_date ?? it.date ?? it.announcement),
    ].join("|");

    const finalKey = key === "|||" ? `__unknown__${unknownCounter++}` : key;

    if (!map.has(finalKey)) {
      map.set(finalKey, { ...it });
    } else {
      const existing = map.get(finalKey)!;
      for (const [k, v] of Object.entries(it)) {
        if ((existing[k] === undefined || existing[k] === null || existing[k] === "") && v !== undefined && v !== null && v !== "") {
          existing[k] = v;
        }
      }
      if (existing.source_url && it.source_url && existing.source_url !== it.source_url) {
        const seen = new Set<string>(
          String(existing.source_url).split(" | ").concat(String(it.source_url).split(" | "))
        );
        existing.source_url = Array.from(seen).join(" | ");
      }
      map.set(finalKey, existing);
    }
  }
  return Array.from(map.values());
}

/**
 * Semantic / fuzzy dedupe using OpenAI embeddings.
 * - items: array of structured records
 * - options.openAiKey: API key (defaults to process.env.OPENAI_API_KEY)
 * - options.model: embedding model (default "text-embedding-3-small")
 * - options.threshold: cosine similarity threshold to consider duplicates (0.88-0.95 recommended)
 * - options.batchSize: number of texts per embedding request (default 64)
 *
 * Returns deduped items (merged group representatives).
 */
export async function dedupeSemantic(
  items: AnyRow[],
  options?: { openAiKey?: string; model?: string; threshold?: number; batchSize?: number }
): Promise<AnyRow[]> {
  const openAiKey = options?.openAiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!openAiKey) throw new Error("Missing OPENAI_API_KEY for semantic dedupe");

  const model = options?.model ?? "text-embedding-3-small";
  const threshold = options?.threshold ?? 0.92;
  const batchSize = options?.batchSize ?? 64;

  const summaries = items.map((it) =>
    [
      it.company || "",
      it.project || it.title || it.source_name || "",
      it.amount_in_inr_crore ?? it.amount ?? "",
      it.state || "",
      it.announcement_date || it.iso_date || it.date || "",
      it.source_url || "",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 1000) // limit length
  );

  // batch embedding requests (OpenAI accepts array inputs; batching avoids very large payloads)
  async function embedBatch(texts: string[]): Promise<(number[] | undefined)[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Embeddings API error ${res.status}: ${body}`);
    }
    const j = await res.json();
    return (j.data || []).map((d: any) => d.embedding as number[] | undefined);
  }

  const embeddings: (number[] | undefined)[] = [];
  for (let i = 0; i < summaries.length; i += batchSize) {
    const batch = summaries.slice(i, i + batchSize);
    const emb = await embedBatch(batch);
    embeddings.push(...emb);
  }

  const cosine = (a?: number[], b?: number[]) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  const used = new Array(items.length).fill(false);
  const groups: number[][] = [];

  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group = [i];
    const ei = embeddings[i];
    if (!ei) {
      groups.push(group);
      continue;
    }
    for (let j = i + 1; j < items.length; j++) {
      if (used[j]) continue;
      const ej = embeddings[j];
      if (!ej) continue;
      const sim = cosine(ei, ej);
      if (sim >= threshold) {
        used[j] = true;
        group.push(j);
      }
    }
    groups.push(group);
  }

  function chooseRepresentative(indices: number[]): AnyRow {
    // prefer larger amount, then presence of company, then presence of source_name, then earliest index
    let bestIdx = indices[0];
    for (const idx of indices) {
      const cur = items[idx];
      const best = items[bestIdx];
      const curAmt = Number(cur.amount_in_inr_crore ?? cur.amount ?? 0);
      const bestAmt = Number(best.amount_in_inr_crore ?? best.amount ?? 0);
      if (curAmt > bestAmt) {
        bestIdx = idx;
      } else if (curAmt === bestAmt) {
        const curHasCompany = cur.company ? 1 : 0;
        const bestHasCompany = best.company ? 1 : 0;
        if (curHasCompany > bestHasCompany) bestIdx = idx;
        else if (curHasCompany === bestHasCompany) {
          const curHasSource = cur.source_name ? 1 : 0;
          const bestHasSource = best.source_name ? 1 : 0;
          if (curHasSource > bestHasSource) bestIdx = idx;
        }
      }
    }
    // merge missing fields from others into representative
    const rep = { ...items[bestIdx] };
    for (const idx of indices) {
      if (idx === bestIdx) continue;
      const other = items[idx];
      for (const [k, v] of Object.entries(other)) {
        if ((rep[k] === undefined || rep[k] === null || rep[k] === "") && v !== undefined && v !== null && v !== "") {
          rep[k] = v;
        } else if (k === "source_url" && rep.source_url && other.source_url && rep.source_url !== other.source_url) {
          const seen = new Set<string>(
            String(rep.source_url).split(" | ").concat(String(other.source_url).split(" | "))
          );
          rep.source_url = Array.from(seen).join(" | ");
        }
      }
    }
    return rep;
  }

  const deduped = groups.map((g) => chooseRepresentative(g));
  return deduped;
}
