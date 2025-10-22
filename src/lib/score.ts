import type { Investment } from "@/lib/types";

export function scoreRecords(arr: Investment[]): Investment[] {
  return arr.map(x => {
    let s = 0;
    if (x.amount_in_inr_crore) s += Math.min(50, Math.log10(1 + x.amount_in_inr_crore) * 20);
    if (x.jobs) s += Math.min(15, Math.log10(1 + x.jobs) * 8);
    if (x.project_type === "Greenfield") s += 10;
    if (x.status === "Operational") s += 15;
    if (x.status === "Construction") s += 8;
    const opportunity_score = Math.round(Math.min(100, s));
    const rationale = "Auto: capex+jobs+stage";
    return { ...x, opportunity_score, rationale };
  });
}
