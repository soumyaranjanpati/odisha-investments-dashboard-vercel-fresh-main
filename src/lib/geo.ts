// Simple state-name detection with common aliases.
// Provides: matchStates(text) -> matched state names
//           isExplicitForState(text, state) -> boolean

const STATE_ALIASES: Record<string, string[]> = {
  "Andhra Pradesh": ["Andhra Pradesh", "AP\\b"],
  "Arunachal Pradesh": ["Arunachal Pradesh"],
  "Assam": ["Assam"],
  "Bihar": ["Bihar"],
  "Chhattisgarh": ["Chhattisgarh"],
  "Goa": ["Goa\\b"],
  "Gujarat": ["Gujarat"],
  "Haryana": ["Haryana"],
  "Himachal Pradesh": ["Himachal Pradesh", "\\bHP\\b"],
  "Jharkhand": ["Jharkhand"],
  "Karnataka": ["Karnataka"],
  "Kerala": ["Kerala"],
  "Madhya Pradesh": ["Madhya Pradesh", "\\bMP\\b"],
  "Maharashtra": ["Maharashtra"],
  "Manipur": ["Manipur"],
  "Meghalaya": ["Meghalaya"],
  "Mizoram": ["Mizoram"],
  "Nagaland": ["Nagaland"],
  "Odisha": ["Odisha", "Orissa"],
  "Punjab": ["Punjab\\b"],
  "Rajasthan": ["Rajasthan"],
  "Sikkim": ["Sikkim"],
  "Tamil Nadu": ["Tamil\\s*Nadu", "Tamilnadu"],
  "Telangana": ["Telangana"],
  "Tripura": ["Tripura"],
  "Uttar Pradesh": ["Uttar\\s*Pradesh", "\\bUP\\b"],
  "Uttarakhand": ["Uttarakhand", "Uttaranchal"],
  "West Bengal": ["West\\s*Bengal", "\\bWB\\b"],
  // UTs
  "Delhi": ["\\bDelhi\\b", "NCT of Delhi"],
  "Jammu and Kashmir": ["Jammu(?:\\s*and\\s*)?Kashmir", "J&K"],
  "Ladakh": ["Ladakh"],
  "Puducherry": ["Puducherry", "Pondicherry"],
  "Chandigarh": ["Chandigarh"],
  "Andaman and Nicobar Islands": ["Andaman(?:\\s*and\\s*)?Nicobar"],
  "Dadra and Nagar Haveli and Daman and Diu": ["Dadra(?:\\s*and\\s*)?Nagar Haveli", "Daman(?:\\s*and\\s*)?Diu"],
  "Lakshadweep": ["Lakshadweep"],
};

const STATE_REGEX: Record<string, RegExp> = Object.fromEntries(
  Object.entries(STATE_ALIASES).map(([state, patterns]) => [
    state,
    new RegExp(`\\b(?:${patterns.join("|")})\\b`, "i"),
  ])
);

export function matchStates(text?: string): string[] {
  if (!text) return [];
  const t = text.replace(/\u00a0/g, " ");
  const hits: string[] = [];
  for (const [state, re] of Object.entries(STATE_REGEX)) {
    if (re.test(t)) hits.push(state);
  }
  return hits;
}

export function isExplicitForState(text: string | undefined, state: string): boolean {
  if (!text) return false;
  const hits = matchStates(text);
  return hits.includes(state);
}

export const ALL_STATES = Object.keys(STATE_ALIASES);
