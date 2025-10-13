import React from "react";

export default function DealsTable({ rows }: { rows: any[] }) {
  return (
    <div className="overflow-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <th>Company</th>
            <th>State</th>
            <th>Sector</th>
            <th>Amount (₹ Cr)</th>
            <th>Status</th>
            <th>Date</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 80).map((r: any, i: number) => (
            <tr key={i} className={i % 2 ? "bg-gray-50" : ""}>
              <td>{r.company || "-"}</td>
              <td>{r.state || "-"}</td>
              <td>{r.sector || "-"}</td>
              <td>{r.amount_in_inr_crore ?? "-"}</td>
              <td>{r.status || "-"}</td>
              <td>{r.announcement_date || "-"}</td>
              <td>
                <a className="underline" href={r.source_url} target="_blank">
                  link
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
