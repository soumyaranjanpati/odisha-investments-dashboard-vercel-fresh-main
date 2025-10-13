import type { Discovered } from "./sources/gdelt";
import type { Investment } from "@/app/api/investments/route";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;

function buildPrompt(batch: Discovered[]) {
  const schema = `Extract an array of JSON objects with keys: company, sector, amount_in_inr_crore (number|null), jobs (number|null), state, district (string|null), project_type (Greenfield|Brownfield|Expansion|MoU|null), status (Announced|Approved|Construction|Operational|MoU|null), announcement_date (YYYY-MM-DD|null), source_url, source_name. If unknown, use null. Do not invent numbers.`;
  const body = batch.map((a,i) => `[#${i+1}] TITLE: ${a.title}\nURL: ${a.url}\nTEXT: ${(a.text||"").slice(0, 5000)}`).join("\n\n");
  return `You are a precise extractor for Indian investment announcements. ${schema}\n\n${body}\n\nReturn STRICT JSON only.`;
}

export async function extractStructured(batch: Discovered[]): Promise<Investment[]> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const prompt = buildPrompt(batch);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }]
    })
  });

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || "{}";
  try {
    const parsed = JSON.parse(content);
    const arr = Array.isArray(parsed) ? parsed : (parsed.data || []);
    return arr.filter((x:any) => x && x.source_url);
  } catch {
    return [];
  }
}
