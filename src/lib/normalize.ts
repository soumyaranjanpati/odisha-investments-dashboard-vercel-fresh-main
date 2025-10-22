import type { Investment } from "@/lib/types";

export function normalizeRecords(arr: any[]): Investment[] {
  return arr.map((x:any) => {
    const state = (x.state || "").replace(/Orissa/i, "Odisha");
    const amount = x.amount_in_inr_crore == null ? null : Number(x.amount_in_inr_crore);
    const jobs = x.jobs == null ? null : Number(x.jobs);
    return {
      company: x.company ?? null,
      sector: x.sector ?? null,
      amount_in_inr_crore: Number.isFinite(amount) ? amount : null,
      jobs: Number.isFinite(jobs) ? jobs : null,
      state: state || null,
      district: x.district ?? null,
      project_type: x.project_type ?? null,
      status: x.status ?? null,
      announcement_date: x.announcement_date ?? null,
      source_url: x.source_url,
      source_name: x.source_name ?? null,
      opportunity_score: 0,
      rationale: ""
    };
  });
}
