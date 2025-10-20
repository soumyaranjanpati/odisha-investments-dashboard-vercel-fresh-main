import type { Investment } from "@/app/api/investments/route";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;

async function boostOne(title: string, url: string, text: string, base: Investment): Promise<Partial<Investment>> {
  const prompt = `From the article below, fill ONLY the missing fields (company, amount_in_inr_crore, jobs, sector). 
Rules: 
- If unsure, keep null.
- Do NOT invent numbers/dates.
- If amount is like "₹500 crore" => amount_in_inr_crore = 500 (number).
- If in lakh, convert: 100 lakh = 1 crore.

Return JSON:
{"company": string|null, "amount_in_inr_crore": number|null, "jobs": number|null, "sector": string|null}

TITLE: ${title}
URL: ${url}
TEXT: ${text.slice(0, 8000)}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) return {};
  const j = await res.json();
  const content = j?.choices?.[0]?.message?.content || "{}";
  try {
    const parsed = JSON.parse(content);
    return {
      company: parsed.company ?? null,
      amount_in_inr_crore: typeof parsed.amount_in_inr_crore === "number" ? parsed.amount_in_inr_crore : null,
      jobs: typeof parsed.jobs === "number" ? parsed.jobs : null,
      sector: parsed.sector ?? null
    };
  } catch {
    return {};
  }
}

export async function boostMissing(itemsByUrl: Map<string, { title: string; text?: string }>, records: Investment[], cap = 12): Promise<Investment[]> {
  if (!OPENAI_API_KEY) return records;
  const targets = records.filter(r => (!r.company || !r.amount_in_inr_crore) && r.source_url).slice(0, cap);

  const upgraded = await Promise.all(targets.map(async (r) => {
    const src = itemsByUrl.get(r.source_url || "");
    if (!src) return r;
    const patch = await boostOne(src.title, r.source_url!, src.text || "", r);
    return { ...r, ...patch };
  }));

  // Merge back
  const set = new Map(records.map(r => [r.source_url, r]));
  for (const u of upgraded) set.set(u.source_url, u);
  return Array.from(set.values());
}
