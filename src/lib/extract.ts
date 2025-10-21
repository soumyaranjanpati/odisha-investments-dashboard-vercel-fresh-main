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

/** Build a strict, anti-hallucination prompt with content verification */
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

CRITICAL ANTI-HALLUCINATION RULES:
- Company: MUST appear verbatim in the article/title as the primary investor.
  Do NOT hallucinate company names unless literally present in the text.
  Do NOT infer companies from context - they must be explicitly named.
  If no specific company is mentioned, set company=null.
- State: MUST be explicitly mentioned in the article text. 
  Do NOT assume states based on the target state parameter.
  If the article doesn't clearly state the project location, set state=null.
- Amount: MUST be explicitly mentioned with numbers in the article.
  Do NOT infer amounts from context or make up numbers.
  If no specific amount is mentioned, set amount_in_inr_crore=null.
- Sector: MUST be clearly indicated in the article text.
  Do NOT infer sectors from company names or context.
  If the sector is not explicitly mentioned, set sector=null.
- VERIFICATION: Before extracting any field, verify it exists in the article text.
  If you cannot find explicit evidence in the text, set the field to null.

STRICT EXTRACTION RULES:
- Company: Must appear verbatim in article/title as the primary investor
- State: Must be explicitly mentioned as the project location
- Amount: Must have explicit numbers (₹X crore, X lakh crore, etc.)
- Sector: Must be clearly indicated in the text
- Project type: One of ["Greenfield","Brownfield","Expansion","MoU","Proposal","Announcement"]
- Status: One of ["MoU","Announced","Approved","Construction","Operational"]
- Dates: Return as YYYY-MM-DD if explicit; else null
- If the article is mainly policy/grants with no specific investable project, return null for unclear fields

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

/** Verify extracted data against article content */
function verifyExtractedData(extracted: ExtractedRow, articleText: string, articleTitle: string): ExtractedRow {
  const text = `${articleTitle} ${articleText}`.toLowerCase();
  const verified = { ...extracted };

  // Verify company exists in text
  if (verified.company) {
    const companyLower = verified.company.toLowerCase();
    if (!text.includes(companyLower)) {
      console.warn(`[VERIFY] Company "${verified.company}" not found in article text`);
      verified.company = null;
    }
  }

  // Verify state exists in text
  if (verified.state) {
    const stateLower = verified.state.toLowerCase();
    if (!text.includes(stateLower)) {
      console.warn(`[VERIFY] State "${verified.state}" not found in article text`);
      verified.state = null;
    }
  }

  // Verify sector exists in text
  if (verified.sector) {
    const sectorKeywords = {
      "Steel": ["steel", "iron", "metal"],
      "Automobile": ["automobile", "vehicle", "car", "ev", "electric vehicle"],
      "Electronics/EMS": ["electronics", "ems", "assembly", "phone", "smartphone"],
      "Semiconductor": ["semiconductor", "chip", "wafer", "fab"],
      "Renewable Energy": ["renewable", "solar", "wind", "green energy"],
      "Oil & Gas": ["oil", "gas", "petroleum", "refinery"],
      "Cement": ["cement"],
      "Textiles": ["textile", "fabric", "garment"],
      "IT/Data Centre": ["it", "data centre", "data center", "software"],
      "Food Processing": ["food", "processing", "agriculture"],
      "Pharma": ["pharma", "pharmaceutical", "medicine"],
      "Logistics/Warehousing": ["logistics", "warehouse", "storage"],
      "Mining": ["mining", "coal", "mineral"],
      "Real Estate/Infra": ["real estate", "infrastructure", "construction"],
      "Chemicals": ["chemical", "petrochemical"]
    };
    
    const keywords = sectorKeywords[verified.sector as keyof typeof sectorKeywords] || [];
    const hasSectorKeywords = keywords.some(keyword => text.includes(keyword));
    
    if (!hasSectorKeywords) {
      console.warn(`[VERIFY] Sector "${verified.sector}" not supported by keywords in article text`);
      verified.sector = null;
    }
  }

  return verified;
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
      const extracted = parsed.map((o: any): ExtractedRow => ({
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

      // Verify each extracted record against its source article
      const verified = extracted.map((record, index) => {
        const sourceItem = items[index];
        if (sourceItem) {
          return verifyExtractedData(record, sourceItem.text || "", sourceItem.title || "");
        }
        return record;
      });

      return verified;
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
