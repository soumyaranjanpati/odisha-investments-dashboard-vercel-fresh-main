// src/lib/types.ts

export type Investment = {
  company: string | null;
  sector: string | null;
  amount_in_inr_crore: number | null;
  jobs: number | null;
  state: string | null;
  district: string | null;
  project_type: "Greenfield" | "Brownfield" | "Expansion" | "MoU" | "Proposal" | "Announcement" | null;
  status: "Announced" | "Approved" | "Construction" | "Operational" | "MoU" | null;
  announcement_date: string | null; // YYYY-MM-DD
  source_url: string;
  source_name: string | null;
  opportunity_score: number;
  rationale: string;
};
