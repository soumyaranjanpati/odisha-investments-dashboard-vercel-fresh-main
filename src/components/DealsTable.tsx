import React, { useMemo, useState } from "react";

type Row = {
  company: string | null;
  state: string | null;
  sector: string | null;
  amount_in_inr_crore: number | null;
  status: string | null;
  announcement_date: string | null;
  source_url: string;
  source_name: string | null;
};

type SortKey = "company" | "state" | "sector" | "amount_in_inr_crore" | "status" | "announcement_date" | "source_name";

export default function DealsTable({ rows }: { rows: Row[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("announcement_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  function onSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir(k === "announcement_date" || k === "amount_in_inr_crore" ? "desc" : "asc");
    }
    setPage(1);
  }

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const A: any = a[sortKey as keyof Row];
      const B: any = b[sortKey as keyof Row];

      // normalize values
      const norm = (v: any) => {
        if (v == null) return null;
        if (sortKey === "announcement_date") return new Date(v).getTime() || 0;
        if (sortKey === "amount_in_inr_crore") return Number(v) || 0;
        return String(v).toLowerCase();
      };

      const va = norm(A);
      const vb = norm(B);

      if (va == null && vb == null) return 0;
      if (va == null) return 1; // nulls last
      if (vb == null) return -1;

      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageSafe = Math.min(page, totalPages);
  const start = (pageSafe - 1) * pageSize;
  const view = sorted.slice(start, start + pageSize);

  function goto(p: number) {
    const clamped = Math.max(1, Math.min(totalPages, p));
    setPage(clamped);
  }

  const caret = (k: SortKey) =>
    sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "▵";

  return (
    <div className="card">
      <div className="table-toolbar">
        <div className="muted">
          Showing <b>{view.length}</b> of <b>{rows.length}</b> records
        </div>
        <div className="flex gap-2 items-center">
          <span className="muted">Rows per page</span>
          <select
            className="input"
            style={{ width: 80, padding: "6px 8px" }}
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <th onClick={() => onSort("company")} className="th-sort">
                Company <span className="sort-caret">{caret("company")}</span>
              </th>
              <th onClick={() => onSort("state")} className="th-sort">
                State <span className="sort-caret">{caret("state")}</span>
              </th>
              <th onClick={() => onSort("sector")} className="th-sort">
                Sector <span className="sort-caret">{caret("sector")}</span>
              </th>
              <th onClick={() => onSort("amount_in_inr_crore")} className="th-sort num">
                Amount (₹ Cr) <span className="sort-caret">{caret("amount_in_inr_crore")}</span>
              </th>
              <th onClick={() => onSort("status")} className="th-sort">
                Status <span className="sort-caret">{caret("status")}</span>
              </th>
              <th onClick={() => onSort("announcement_date")} className="th-sort">
                Date <span className="sort-caret">{caret("announcement_date")}</span>
              </th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r, i) => (
              <tr key={start + i} className={i % 2 ? "bg-gray-50" : ""}>
                <td>{r.company || <span className="muted">—</span>}</td>
                <td>{r.state || <span className="muted">—</span>}</td>
                <td>{r.sector || <span className="muted">—</span>}</td>
                <td className="num">
                  {r.amount_in_inr_crore != null ? r.amount_in_inr_crore : <span className="muted">—</span>}
                </td>
                <td>{r.status || <span className="muted">—</span>}</td>
                <td>
                  {r.announcement_date ? new Date(r.announcement_date).toLocaleDateString() : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <a className="link" href={r.source_url} target="_blank" rel="noreferrer">
                    {r.source_name || "link"}
                  </a>
                </td>
              </tr>
            ))}
            {view.length === 0 && (
              <tr>
                <td colSpan={7} className="muted p-2">
                  No results
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="pager">
        <div className="muted">
          Page <b>{pageSafe}</b> / {totalPages}
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => goto(1)} disabled={pageSafe === 1}>
            ⏮ First
          </button>
          <button className="btn" onClick={() => goto(pageSafe - 1)} disabled={pageSafe === 1}>
            ◀ Prev
          </button>
          <button className="btn" onClick={() => goto(pageSafe + 1)} disabled={pageSafe === totalPages}>
            Next ▶
          </button>
          <button className="btn" onClick={() => goto(totalPages)} disabled={pageSafe === totalPages}>
            Last ⏭
          </button>
        </div>
      </div>
    </div>
  );
}
