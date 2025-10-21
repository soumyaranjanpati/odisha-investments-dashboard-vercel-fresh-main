// src/lib/dedupe.ts
import type { Investment } from "@/lib/types";

/**
 * Normalize a URL for stable comparisons (strip protocol, www, trailing slash, anchors).
 */
// export function normalizeUrl(u: string): string {
//   try {
//     const url = new URL(u);
//     const host = url.hostname.replace(/^www\./i, "").toLowerCase();
//     const path = url.pathname.replace(/\/+$/, "");
//     const qs = url.searchParams.toString(); // keep query to distinguish article pages if needed
//     const core = `${host}${path}${qs ? "?" + qs : ""}`;
//     return core.toLowerCase();
//   } catch {
//     return (u || "").trim().toLowerCase();
//   }
// }
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    // ❌ Remove: const qs = url.searchParams.toString();
    // ✅ Ignore query strings entirely for deduplication
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
 * Smart-ish de-duplication:
 * - Collapse items with identical normalized URLs.
 * - Also collapse near-duplicate titles (same normalized title) keeping the "better" record:
 *   preference order: higher amount, then higher opportunity_score, then has company, then newer date.
 */
export function dedupeRecordsSmart(
  rows: Investment[],
  titleByUrl: Map<string, string>
): Investment[] {
  // Stage 1: dedupe by normalized URL
  const byUrl = new Map<string, Investment>();
  for (const r of rows) {
    const key = normalizeUrl(r.source_url);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, r);
      continue;
    }
    // Prefer with larger amount or higher score
    const prevAmt = prev.amount_in_inr_crore ?? 0;
    const curAmt = r.amount_in_inr_crore ?? 0;
    if (curAmt > prevAmt) {
      byUrl.set(key, r);
    } else if (curAmt === prevAmt) {
      if (r.opportunity_score > prev.opportunity_score) byUrl.set(key, r);
    }
  }
  const urlCollapsed = Array.from(byUrl.values());

  // Stage 2: dedupe by normalized title (across different URLs)
  const byTitle = new Map<string, Investment>();
  for (const r of urlCollapsed) {
    const t = titleByUrl.get(normalizeUrl(r.source_url)) ?? "";
    const nt = normTitle(t);
    if (!nt) {
      // if no title, group by url key already handled
      if (!byTitle.has(r.source_url)) byTitle.set(r.source_url, r);
      continue;
    }
    const prev = byTitle.get(nt);
    if (!prev) {
      byTitle.set(nt, r);
      continue;
    }
    // Choose the "better" record on same title
    const prevAmt = prev.amount_in_inr_crore ?? 0;
    const curAmt = r.amount_in_inr_crore ?? 0;
    if (curAmt > prevAmt) {
      byTitle.set(nt, r);
    } else if (curAmt === prevAmt) {
      if ((r.company ? 1 : 0) > (prev.company ? 1 : 0)) byTitle.set(nt, r);
      else if (r.opportunity_score > prev.opportunity_score) byTitle.set(nt, r);
      else {
        // If dates exist, pick newer
        const pDate = prev.announcement_date ? Date.parse(prev.announcement_date) : 0;
        const cDate = r.announcement_date ? Date.parse(r.announcement_date) : 0;
        if (cDate > pDate) byTitle.set(nt, r);
      }
    }
  }

  return Array.from(byTitle.values());
}
