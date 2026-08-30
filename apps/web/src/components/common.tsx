import type { JsonObject } from "@kalki/contracts";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Database } from "lucide-react";
import { cellText, label } from "../lib/format.js";

export function StatusPill({
  value,
  tone = "neutral",
}: {
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <span className={`status-pill status-pill--${tone}`}>{label(value)}</span>
  );
}

export function EmptyState({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">{icon}</span>
      <strong>{title}</strong>
    </div>
  );
}

export function DataGrid({ rows }: { rows: JsonObject[] }) {
  const columns = useMemo(() => {
    const names: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!names.includes(key)) names.push(key);
        if (names.length === 12) return names;
      }
    }
    return names;
  }, [rows]);

  if (rows.length === 0)
    return <EmptyState icon={<Database size={19} />} title="No rows" />;

  return (
    <div className="data-grid-wrap">
      <table className="data-grid">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{label(column)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${index}-${columns.map((column) => cellText(row[column])).join("|")}`}
            >
              {columns.map((column) => {
                const value = cellText(row[column]);
                return (
                  <td key={column} title={value}>
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
