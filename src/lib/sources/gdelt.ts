export type Discovered = { title: string; url: string; publishedAt?: string; source?: string; text?: string };

const KEYWORDS = /(investment|fdi|mou|plant|factory|expansion|manufactur|greenfield|brownfield)/i;

export async function discoverViaGdelt(states: string[], maxRecords = 60, window = "30d"): Promise<Discovered[]> {
  const queries = states.map(s => `(investment OR FDI OR "investment proposal" OR MoU) AND ${s} sourceCountry:IN`);
  const calls = queries.map(q => `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&maxrecords=${Math.min(maxRecords, 70)}&format=json`);

  const results = await Promise.allSettled(calls.map(u => fetch(u).then(r => r.json())));

  const items = results.flatMap(r => {
    if (r.status !== "fulfilled") return [] as any[];
    const j: any = r.value;
    const docs = j?.articles || j?.docs || [];
    return docs.map((a: any) => ({
      title: a.title || a.semtag || "",
      url: a.url || a.urlArticle || a.sourceUrl || "",
      publishedAt: a.seendate || a.publishtime || a.publishedAt,
      source: a.sourceDomain || a.domain || a.source
    }));
  });

  return items
    .filter(a => a.url)
    .filter(a => KEYWORDS.test(`${a.title}`))
    .slice(0, maxRecords);
}
