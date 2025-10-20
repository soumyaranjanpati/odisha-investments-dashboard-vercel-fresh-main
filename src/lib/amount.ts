// Robust INR amount parsing (crore/lakh) from free text.
// Finds ALL matches and returns the largest in crore units (number).

/**
 * Parse *all* INR-like amounts in the text and return the max in crore.
 * Supports: "₹3,150 crore", "Rs 3,150-crore", "INR 250 cr", "900 crore",
 *           "75 lakh" (converted to 0.75 cr), with commas/decimals/hyphens.
 */
export function maxInrAmountCrore(text: string): number | null {
  if (!text) return null;
  const T = text.replace(/\u00a0/g, " "); // nbsp -> space

  // e.g., "₹3,150 crore", "Rs 3,150-crore", "INR 250 cr"
  const RE_CRORE = /(?:₹|rs\.?|inr)?\s*([\d]{1,3}(?:[,]\d{2,3})+|\d+(?:\.\d+)?)\s*-?\s*(?:crore|cr)\b/gi;

  // e.g., "75 lakh" / "100 lac"
  const RE_LAKH  = /(?:₹|rs\.?|inr)?\s*([\d]{1,3}(?:[,]\d{2,3})+|\d+(?:\.\d+)?)\s*-?\s*(?:lakh|lac)\b/gi;

  let maxCr: number | null = null;

  const upd = (valCr: number) => {
    if (!Number.isFinite(valCr)) return;
    if (valCr <= 0) return;
    if (maxCr == null || valCr > maxCr) maxCr = valCr;
  };

  const toNum = (s: string) => parseFloat(s.replace(/,/g, ""));

  let m: RegExpExecArray | null;
  while ((m = RE_CRORE.exec(T)) !== null) {
    const n = toNum(m[1]);
    if (Number.isFinite(n)) upd(n);
  }
  while ((m = RE_LAKH.exec(T)) !== null) {
    const n = toNum(m[1]);
    if (Number.isFinite(n)) upd(n / 100); // lakh -> crore
  }

  return maxCr;
}
