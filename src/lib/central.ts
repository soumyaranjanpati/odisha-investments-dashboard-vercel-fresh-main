// src/lib/central.ts
// Detect if an investment project is by/through Central Government

export function detectCentralGovernmentProject(text?: string): boolean {
  if (!text) return false;
  const T = text.toLowerCase();

  // Core government indicators
  const CENTRAL_PATTERNS = [
    "prime minister",
    "pm modi",
    "narendra modi",
    "union minister",
    "government of india",
    "central government",
    "goi ",
    "railway minister",
    "ministry of",
    "union ministry",
    "national highway authority",
    "nhai",
    "iit ",
    "nit ",
    "aiims",
    "indian oil corporation",
    "bharat petroleum",
    "hindustan petroleum",
    "ntpc",
    "power grid corporation",
    "bharat heavy electricals",
    "bhel",
    "gail",
    "ongc",
    "sail ",
    "coal india",
    "niti aayog",
  ];

  return CENTRAL_PATTERNS.some((kw) => T.includes(kw));
}
