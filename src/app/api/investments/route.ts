export const runtime = "edge";

export type Investment = {
  company: string | null;
  sector: string | null;
  amount_in_inr_crore: number | null;
  jobs: number | null;
  state: string | null;
  district: string | null;
  project_type: "Greenfield" | "Brownfield" | "Expansion" | "MoU" | null;
  status: "Announced" | "Approved" | "Construction" | "Operational" | "MoU" | null;
  announcement_date: string | null;
  source_url: string;
  source_name: string | null;
  opportunity_score: number;
  rationale: string;
};

const MAX_RECORDS = parseInt(process.env.MAX_RECORDS || "60", 10);
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE  || "6", 10);

import { discoverViaGdelt } from "@/lib/sources/gdelt";
import { extractStructured } from "@/lib/extract";
import { normalizeRecords } from "@/lib/normalize";
import { scoreRecords } from "@/lib/score";

function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, s-maxage=${process.env.CACHE_S_MAXAGE || 300}, stale-while-revalidate=${process.env.CACHE_STALE_WHILE_REVALIDATE || 60}`,
      "access-control-allow-origin": "*"
    }
  });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const window = searchParams.get("window") || "30d";
    const debug = searchParams.get("debug") === "1";
    const raw = searchParams.get("raw") === "1";
    const states = (searchParams.get("states") || "Odisha,Andhra Pradesh,Gujarat,Karnataka,Tamil Nadu,Uttar Pradesh,Maharashtra")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const openaiKeyPresent = !!process.env.OPENAI_API_KEY;

    // 1) Discover candidate links
    const gdeltItems = await discoverViaGdelt(states, MAX_RECORDS, window);

    if (raw) {
      return jsonResponse({ discovered: gdeltItems.length, sample: gdeltItems.slice(0, 10) });
    }

    if (debug) {
      return jsonResponse({
        ok: true,
        meta: {
          openaiKeyPresent,
          stateCount: states.length,
          discoveredCount: gdeltItems.length,
          sample: gdeltItems.slice(0, 5)
        }
      });
    }

    if (!openaiKeyPresent) {
      return jsonResponse({ error: "OPENAI_API_KEY is not set in the environment." }, 500);
    }

    if (gdeltItems.length === 0) {
      return jsonResponse([]);
    }

    // 2) Fetch HTML -> extract text (best effort)
    const itemsWithText = await Promise.all(gdeltItems.map(async (a) => {
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
        return a;
      }
    }));

    // 3) OpenAI extraction (batched)
    const batches: any[][] = [];
    for (let i = 0; i < itemsWithText.length; i += BATCH_SIZE) {
      batches.push(itemsWithText.slice(i, i + BATCH_SIZE));
    }

    const extractedArrays = await Promise.all(batches.map(async (batch) => {
      try {
        return await extractStructured(batch);
      } catch {
        return [];
      }
    }));
    const extracted = extractedArrays.flat();

    // 4) Normalize, score, dedupe (in-memory)
    const normalized = normalizeRecords(extracted);
    const scored = scoreRecords(normalized);
    const seen = new Set<string>();
    const deduped = scored.filter(x => {
      const key = `${x.source_url}|${x.company||""}|${x.state||""}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });

    return jsonResponse(deduped);
  } catch (e: any) {
    return jsonResponse({ error: e?.message || String(e) }, 500);
  }
}
