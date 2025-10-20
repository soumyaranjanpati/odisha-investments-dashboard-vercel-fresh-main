// src/lib/enrich.ts
import type { Investment } from "@/lib/types";

/**
 * Normalize candidate record to strict Investment shape.
 * Ensures no `undefined` leaks — only explicit nulls for empty fields.
 */
export function toInvestment(p: Partial<Investment>): Investment {
  return {
    company: p.company ?? null,
    sector: p.sector ?? null,
    amount_in_inr_crore: p.amount_in_inr_crore ?? null,
    jobs: p.jobs ?? null,
    state: p.state ?? null,
    district: p.district ?? null,
    project_type: (p.project_type as Investment["project_type"]) ?? null,
    status: (p.status as Investment["status"]) ?? null,
    announcement_date: p.announcement_date ?? null,
    source_url: p.source_url ?? "",
    source_name: p.source_name ?? null,
    opportunity_score: p.opportunity_score ?? 0,
    rationale: p.rationale ?? "",
  };
}

/**
 * Lightweight heuristics to backfill missing fields from discovery artifact.
 * `disc` is the discovered item: { title, url, source, tagged_state, iso_date, text? }
 * `base` is a partially filled Investment (from LLM or initial heuristic).
 */
export function enrichFromHeuristics(
  disc: any,
  base: Partial<Investment>
): Partial<Investment> {
  const title = (disc?.title as string) || "";
  const text = (disc?.text as string) || "";
  const state = (base.state ?? disc?.tagged_state ?? null) as Investment["state"];
  const source_url = (base.source_url ?? disc?.url ?? "") as string;
  const source_name = (base.source_name ?? disc?.source ?? null) as string | null;
  const announcement_date = (base.announcement_date ?? disc?.iso_date ?? null) as string | null;

  // Try to detect company from title if missing (simple, safe heuristics)
  let company = base.company ?? null;
  if (!company) {
    // Very basic patterns: “X signs MoU”, “X to invest”, “X announces”, “X plans”
    const m =
      title.match(
        /^(.*?)(?:\s+signs|\s+inks|\s+to\s+invest|\s+invests|\s+announces|\s+plans|\s+set(?:s)?\s+up|\s+proposes|\s+builds|\s+expands)\b/i
      ) ||
      title.match(/^(.*?)\s+and\s+.*\bMoU\b/i);
    if (m && m[1]) {
      const raw = m[1]
        .replace(/^(breaking|update|good news for)\s*[:,]?\s*/i, "")
        .replace(/\s*official\s*[:\-].*$/i, "")
        .trim();
      // Trim noisy tokens at ends
      const cleaned = raw
        .replace(/\b(ceo|minister|cm|pm|mr|ms|mrs|dr|shri|smt)\b.*$/i, "")
        .replace(/[“”"':.,]+$/g, "")
        .trim();
      if (cleaned && cleaned.length <= 60) company = cleaned;
    }
  }

  // If still missing, try to find org-like tokens in text (very mild)
  if (!company) {
    const orgHit = text.match(/\b([A-Z][A-Za-z&.\- ]{2,40}?(?:Ltd|Limited|Corporation|Corp|Industries|Energy|Power|Steel|Cement|Enterprises|Group|Authority|Ministry|Commission|Board))\b/);
    if (orgHit && orgHit[1]) company = orgHit[1].trim();
  }

  // Project type/status quick fill from title
  let project_type = base.project_type ?? null;
  if (!project_type) {
    if (/mou/i.test(title)) project_type = "MoU";
    else if (/expansion|expand/i.test(title)) project_type = "Expansion";
    else if (/greenfield/i.test(title)) project_type = "Greenfield";
    else if (/brownfield/i.test(title)) project_type = "Brownfield";
  }

  let status = base.status ?? null;
  if (!status) {
    if (/mou/i.test(title)) status = "MoU";
    else if (/inaugurate|launch|operational/i.test(text)) status = "Operational";
    else if (/construction|groundbreaking|bhumi pujan/i.test(text)) status = "Construction";
    else if (/approve|approved/i.test(text)) status = "Approved";
    else status = "Announced";
  }

  // Sector light hint
  let sector = base.sector ?? null;
  if (!sector) {
  const pairs: Array<[RegExp, string]> = [
    [/steel|ferro|metal/i, "Steel"],
    [/renewable|solar|wind|green energy|module|cell/i, "Renewable Energy"],
    [/semiconductor|chip|fab/i, "Semiconductor"],
    [/textile|garment|apparel|loom/i, "Textiles"],
    [/food\s*processing|agri|dairy|rice mill|cold\s*storage/i, "Food Processing"],
    [/auto(?!\s*pilot)|ev\b|battery/i, "Automobile"],
    [/pharma|biotech|formulation/i, "Pharma"],
    [/it\s*park|data\s*centre|data\s*center|software/i, "IT/Data Centre"],
    [/chemic|petrochem|refinery|fertilizer/i, "Chemicals"],
    [/cement/i, "Cement"],
    [/electronics|ems|assembly/i, "Electronics"],
  ];

  for (const [re, label] of pairs) {
    if (re.test(title) || re.test(text)) {
      sector = label;
      break;
    }
  }
}


  // Rationale default
  const rationale =
    base.rationale ??
    (project_type === "MoU" ? "MoU detected in title" : "Heuristic enrichment");

  return {
    ...base,
    company: company ?? null,
    sector: sector ?? null,
    state,
    announcement_date,
    source_url,
    source_name,
    project_type,
    status,
    rationale,
  };
}
