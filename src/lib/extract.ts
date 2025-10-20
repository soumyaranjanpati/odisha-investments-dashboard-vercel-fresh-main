// src/lib/extract.ts
// OpenAI extraction helpers (prompt, call, JSON parsing, preview)

type InItem = {
  title: string;
  text: string;
  url: string;
  tagged_state: string;
  source?: string | null;
  iso_date?: string | null;
};

/** Strict unions for project_type and status */
export const PROJECT_TYPES = [
  "Greenfield",
  "Brownfield",
  "Expansion",
  "MoU",
  "Proposal",
  "Announcement",
] as const;
export type ProjectType = typeof PROJECT_TYPES[number];

export const STATUS_TYPES = [
  "MoU",
  "Announced",
  "Approved",
  "Construction",
  "Operational",
] as const;
export type StatusType = typeof STATUS_TYPES[number];

export type ExtractedRow = {
  company: string | null;
  sector: string | null;
  amount_in_inr_crore: number | null;
  jobs: number | null;
  state: string | null;
  district: string | null;
  project_type: ProjectType | null;
  status: StatusType | null;
  announcement_date: string | null; // YYYY-MM-DD
  source_url: string;
  source_name: string | null;
};

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

/** Build a strict, anti-hallucination prompt */
export function buildPromptForInvestments(items: InItem[]): string {
  const articles = items
    .map((it, i) => {
      const txt = (it.text || "").slice(0, 8000);
      return `### ARTICLE ${i + 1}
URL: ${it.url}
STATE (target): ${it.tagged_state}
TITLE: ${it.title}
TEXT:
${txt}`;
    })
    .join("\n\n");

  return `
You are an information extraction system for Indian investment news.
Extract ONLY when facts are explicit in the article/title. If unsure, set the field to null.

STRICT RULES:
- Company: MUST appear verbatim in the article/title as the primary investor.
  Do NOT hallucinate Big Tech names (Microsoft, Google, Apple, etc.) unless literally present AND they are the investor.
  Prefer names in the TITLE over body if multiple orgs are present. If multiple orgs invest, pick the main investor mentioned.
- State: Keep as the article’s project location. If the investment is pan-India with no specific state, set state=null.
- Amount: Return INR crores as a number.
  • Convert lakh crore correctly (₹1.5 lakh crore → 150000 crore).
  • If a range is given, return the clearest single value; else null.
- Sector: Choose ONE from:
  ["Electronics/EMS","Semiconductor","Renewable Energy","Automobile","Steel","Chemicals","Cement","Textiles","IT/Data Centre","Food Processing","Pharma","Logistics/Warehousing","Mining","Real Estate/Infra","Oil & Gas"].
  • Use Automobile ONLY if the article clearly mentions vehicles/car/EV/two-wheeler/bus/truck/OEM.
  • Use Electronics/EMS for phones/iPhone, EMS/assembly/PCB/module/display/connector/contract manufacturing.
  • Use Semiconductor for chip/fab/wafer/ATMP/OSAT terms.
- Project type: One of ["Greenfield","Brownfield","Expansion","MoU","Proposal","Announcement"].
- Status: One of ["MoU","Announced","Approved","Construction","Operational"].
- Dates: Return as YYYY-MM-DD if explicit; else null.
- If the article is mainly policy/grants with no specific investable project, return null for unclear fields.
- Output JSON ONLY (no commentary). Return an array with one object per article, preserving order.

OUTPUT SHAPE:
[
  {
    "company": string|null,
    "sector": string|null,
    "amount_in_inr_crore": number|null,
    "jobs": number|null,
    "state": string|null,
    "district": string|null,
    "project_type": "Greenfield"|"Brownfield"|"Expansion"|"MoU"|"Proposal"|"Announcement"|null,
    "status": "MoU"|"Announced"|"Approved"|"Construction"|"Operational"|null,
    "announcement_date": "YYYY-MM-DD"|null,
    "source_url": string,
    "source_name": string|null
  }, ...
]

ARTICLES:
${articles}
`;
}

export function buildPromptPreview(items: InItem[]): string {
  const prompt = buildPromptForInvestments(items);
  return prompt.slice(0, 16000);
}

/** Try to extract a JSON array from LLM content */
function pickJson(text: string): string | null {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first >= 0 && last > first) return text.slice(first, last + 1).trim();
  return null;
}

/** Narrow arbitrary value to ProjectType|null */
function asProjectType(v: any): ProjectType | null {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  return (PROJECT_TYPES as readonly string[]).includes(s) ? (s as ProjectType) : null;
}

/** Narrow arbitrary value to StatusType|null */
function asStatus(v: any): StatusType | null {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  return (STATUS_TYPES as readonly string[]).includes(s) ? (s as StatusType) : null;
}

/** Call OpenAI and parse into structured array */
export async function extractStructured(items: InItem[]): Promise<ExtractedRow[]> {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const prompt = buildPromptForInvestments(items);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are a precise, non-hallucinating information extraction engine.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  const payload = await res.json().catch(() => ({} as any));
  const content =
    payload?.choices?.[0]?.message?.content ||
    payload?.choices?.[0]?.delta?.content ||
    "";

  const jsonStr = pickJson(content) || content;

  try {
    const parsed = JSON.parse(jsonStr) as any[];
    if (Array.isArray(parsed)) {
      return parsed.map((o: any): ExtractedRow => ({
        company: orNullString(o.company),
        sector: orNullString(o.sector),
        amount_in_inr_crore: orNullNumber(o.amount_in_inr_crore),
        jobs: orNullNumber(o.jobs),
        state: orNullString(o.state),
        district: orNullString(o.district),
        project_type: asProjectType(o.project_type),
        status: asStatus(o.status),
        announcement_date: orNullString(o.announcement_date),
        source_url: String(o.source_url || ""),
        source_name: orNullString(o.source_name),
      }));
    }
  } catch {
    // ignore parse errors and fall back to []
  }
  return [];
}

function orNullString(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function orNullNumber(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
