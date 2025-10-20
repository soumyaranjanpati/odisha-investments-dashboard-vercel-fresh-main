"use client";

import { useEffect, useMemo, useState } from "react";
import type { Investment } from "@/lib/types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  LineChart,
  Line,
} from "recharts";

const ALL_STATES = [
  "Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand",
  "Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan",
  "Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal",
  "Andaman and Nicobar Islands","Chandigarh","Dadra and Nagar Haveli and Daman and Diu","Delhi","Jammu and Kashmir","Ladakh","Lakshadweep","Puducherry"
];

type SortKey =
  | "announcement_date"
  | "state"
  | "company"
  | "project_type"
  | "sector"
  | "amount_in_inr_crore"
  | "jobs";
type SortDir = "asc" | "desc";

export default function Page() {
  const [selectedStates, setSelectedStates] = useState<string[]>(["Odisha","Tamil Nadu","Gujarat","Maharashtra"]);
  const [windowStr, setWindowStr] = useState("30d");
  const [data, setData] = useState<Investment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("announcement_date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function fetchNow() {
    setLoading(true);
    setError(null);
    setPage(1); // reset pagination
    try {
      const url = `/api/investments?states=${encodeURIComponent(selectedStates.join(","))}&window=${encodeURIComponent(windowStr)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
      const json = await res.json();
      const rows: Investment[] = Array.isArray(json) ? json : Array.isArray(json?.sample) ? json.sample : [];
      setData(rows);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Failed to fetch");
      setData([]);
    } finally {
      setLoading(false);
    }
  }

  // ❌ Removed auto-fetch on load
  // useEffect(() => { fetchNow(); }, []);

  function onSort(col: SortKey) {
    if (sortKey === col) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(col);
      setSortDir(col === "announcement_date" ? "desc" : "asc");
    }
  }

  const sortedData = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const va: any = (a as any)[sortKey];
      const vb: any = (b as any)[sortKey];
      if (sortKey === "announcement_date") {
        const da = va ? Date.parse(va) : 0;
        const db = vb ? Date.parse(vb) : 0;
        return sortDir === "asc" ? da - db : db - da;
      }
      if (sortKey === "amount_in_inr_crore" || sortKey === "jobs") {
        const na = typeof va === "number" ? va : -Infinity;
        const nb = typeof vb === "number" ? vb : -Infinity;
        return sortDir === "asc" ? na - nb : nb - na;
      }
      const sa = (va ?? "").toString().toLowerCase();
      const sb = (vb ?? "").toString().toLowerCase();
      if (sa < sb) return sortDir === "asc" ? -1 : 1;
      if (sa > sb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  // Pagination slice
  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const paged = sortedData.slice((page - 1) * pageSize, page * pageSize);

  const totalAmount = useMemo(() => {
    return data.reduce(
      (sum, r) => sum + (typeof r.amount_in_inr_crore === "number" ? r.amount_in_inr_crore : 0),
      0
    );
  }, [data]);

  const barByState = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data) {
      if (!r.state) continue;
      const amt = typeof r.amount_in_inr_crore === "number" ? r.amount_in_inr_crore : 0;
      if (amt <= 0) continue;
      m.set(r.state, (m.get(r.state) || 0) + amt);
    }
    return Array.from(m, ([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  }, [data]);

  const lineByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data) {
      const d = r.announcement_date;
      const amt = typeof r.amount_in_inr_crore === "number" ? r.amount_in_inr_crore : 0;
      if (!d || amt <= 0) continue;
      m.set(d, (m.get(d) || 0) + amt);
    }
    return Array.from(m, ([date, amount]) => ({ date, amount })).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [data]);

  function SortLabel({ col, label }: { col: SortKey; label: string }) {
    const active = sortKey === col;
    return (
      <button
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 ${active ? "text-black font-semibold" : "text-slate-700"} hover:underline`}
      >
        <span>{label}</span>
        {active && <span className="text-xs">{sortDir === "asc" ? "▲" : "▼"}</span>}
      </button>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-[15px] leading-relaxed">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-1">India Investment Dashboard</h1>
        <p className="text-slate-600 mb-6">Select states and click <strong>Fetch Now</strong> to view the latest AI-extracted investment insights.</p>

        {/* Controls */}
        <div className="flex flex-wrap gap-4 mb-6 items-end">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">States (multi-select)</label>
            <select
              multiple
              value={selectedStates}
              onChange={(e) => setSelectedStates(Array.from(e.target.selectedOptions).map(o => o.value))}
              className="w-64 h-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              {ALL_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Window</label>
            <select
              className="w-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              value={windowStr}
              onChange={(e) => setWindowStr(e.target.value)}
            >
              <option value="7d">Last 7 days</option>
              <option value="14d">Last 14 days</option>
              <option value="30d">Last 30 days</option>
              <option value="60d">Last 60 days</option>
            </select>
          </div>

          <button
            onClick={fetchNow}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-lg bg-black text-white px-5 py-2 text-sm font-medium shadow hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Fetching…" : "Fetch Now"}
          </button>
        </div>

        {/* Empty state */}
        {!loading && data.length === 0 && !error && (
          <div className="text-slate-600 text-sm mb-6">
            Select one or more states and click <strong>Fetch Now</strong> to load results.
          </div>
        )}

        {/* Charts */}
        {data.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="font-semibold mb-2 text-[15px]">Total Investment by State (₹ crore)</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barByState.slice(0, 10)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="amount" fill="#2563eb" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="font-semibold mb-2 text-[15px]">Daily Total Investment (₹ crore)</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={lineByDate}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="amount" stroke="#16a34a" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* Table */}
        {data.length > 0 && (
          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex justify-between items-center bg-slate-50">
              <h2 className="font-semibold text-[15px]">Results ({data.length} records)</h2>
              <div className="text-sm text-slate-600">
                Total Amount: ₹ {totalAmount.toLocaleString("en-IN")}
              </div>
            </div>

            {error && (
              <div className="px-4 py-3 bg-red-50 text-red-700 border-b border-red-200 text-sm">{error}</div>
            )}

            <div className="overflow-x-auto">
              <table className="min-w-full text-[15px] font-medium text-slate-800">
                <thead className="bg-slate-100 text-[14px] font-semibold text-slate-700 uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-3 text-left"><SortLabel col="announcement_date" label="Date" /></th>
                    <th className="px-3 py-3 text-left"><SortLabel col="state" label="State" /></th>
                    <th className="px-3 py-3 text-left"><SortLabel col="company" label="Company" /></th>
                    <th className="px-3 py-3 text-left"><SortLabel col="project_type" label="Type" /></th>
                    <th className="px-3 py-3 text-left"><SortLabel col="sector" label="Sector" /></th>
                    <th className="px-3 py-3 text-left"><SortLabel col="amount_in_inr_crore" label="Amount (₹ cr)" /></th>
                    <th className="px-3 py-3 text-left"><SortLabel col="jobs" label="Jobs" /></th>
                    <th className="px-3 py-3 text-left">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paged.map((r, i) => (
                    <tr
                      key={r.source_url + i}
                      className={i % 2 === 0 ? "bg-white hover:bg-slate-50" : "bg-slate-50 hover:bg-slate-100"}
                    >
                      <td className="px-3 py-3">{r.announcement_date || "-"}</td>
                      <td className="px-3 py-3">{r.state || "-"}</td>
                      <td className="px-3 py-3">{r.company || "-"}</td>
                      <td className="px-3 py-3">{r.project_type || r.status || "-"}</td>
                      <td className="px-3 py-3">{r.sector || "-"}</td>
                      <td className="px-3 py-3">
                        {r.amount_in_inr_crore ? r.amount_in_inr_crore.toLocaleString("en-IN") : "-"}
                      </td>
                      <td className="px-3 py-3">{r.jobs ?? "-"}</td>
                      <td className="px-3 py-3">
                        <a href={r.source_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                          {r.source_name || "link"}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination footer */}
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 sm:justify-between sm:items-center px-4 py-3 border-t border-slate-200 bg-slate-50 sticky bottom-0">
              {/* Page info */}
              <div className="text-sm text-slate-700">
                Page <span className="font-semibold">{page}</span> of <span className="font-semibold">{totalPages}</span>
              </div>

              {/* Controls */}
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                      <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page <= 1}
                        className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold
                                  bg-black text-white hover:bg-slate-800 transition
                                  disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label="Previous page"
                        title="Previous"
                      >
                        <span aria-hidden>‹</span> Prev
                      </button>

                      <button
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages}
                        className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold
                                  bg-black text-white hover:bg-slate-800 transition
                                  disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label="Next page"
                        title="Next"
                      >
                        Next <span aria-hidden>›</span>
                      </button>

                      <div className="hidden sm:block h-6 w-px bg-slate-300 mx-1" />

                      <label className="text-sm text-slate-700 inline-flex items-center gap-2">
                        Rows per page
                        <select
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(parseInt(e.target.value, 10));
                            setPage(1);
                          }}
                        >
                          {[10, 20, 50].map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>

          </section>
        )}
      </div>
    </main>
  );
}
