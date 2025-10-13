"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import DealsTable from "@/components/DealsTable";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export default function Home() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchNow() {
    setLoading(true);
    try {
      const url = "/api/investments?states=Odisha,Andhra Pradesh,Gujarat,Maharashtra,Tamil Nadu,Karnataka,Uttar Pradesh&window=30d";
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });

      console.log("[fetch] status:", res.status, res.statusText);
      if (!res.ok) {
        const text = await res.text();
        console.error("[fetch] non-OK response:", text);
        alert(`Server error ${res.status}: ${text}`);
        return;
      }

      const json = await res.json();
      console.log("[fetch] records:", Array.isArray(json) ? json.length : "n/a");
      if (Array.isArray(json) && json.length === 0) {
        alert("No records found. Try a smaller state list, or confirm OPENAI_API_KEY on Vercel.");
      }
      setData(json);
    } catch (e: any) {
      console.error(e);
      alert(`Failed to fetch: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  const byState = Object.values(
    data.reduce((acc:any, x:any) => {
      const k = x.state || "Unknown";
      acc[k] = acc[k] || { name: k, value: 0 };
      acc[k].value += Number(x.amount_in_inr_crore || 0);
      return acc;
    }, {})
  );

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">India Investments Dashboard (Live • Stateless)</h1>
      <p>Click the button to fetch the latest investment news and extract structured records in real time (no storage).</p>
      <div className="flex gap-3">
        <button onClick={fetchNow} disabled={loading} style={{padding: '8px 16px', borderRadius: 8, background: '#111', color: '#fff', border: 'none'}}>
          {loading ? "Fetching…" : "Fetch latest"}
        </button>
      </div>

      {data.length > 0 && (
        <>
          <ReactECharts option={{
            title: { text: "Total Announced Amount by State (₹ Cr)" },
            tooltip: { trigger: "item" },
            xAxis: { type: "category", data: (byState as any[]).map((d:any)=>d.name) },
            yAxis: { type: "value" },
            series: [{ type: "bar", data: (byState as any[]).map((d:any)=>d.value) }]
          }} style={{ height: 360 }} />

          <DealsTable rows={data} />
        </>
      )}
    </main>
  );
}
