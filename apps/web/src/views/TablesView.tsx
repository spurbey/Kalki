import type { TableRow, WorkbookSnapshot } from "@kalki/contracts";
import { CircleAlert, LoaderCircle, Plus, Rows3, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../api.js";
import { DataGrid, EmptyState, StatusPill } from "../components/common.js";
import { formatTime, label } from "../lib/format.js";

export function TablesView({ snapshot }: { snapshot: WorkbookSnapshot }) {
  const productionRuns = useMemo(
    () =>
      [...snapshot.runs]
        .filter((run) => run.mode === "production")
        .sort((left, right) => right.created_at.localeCompare(left.created_at)),
    [snapshot.runs],
  );
  const preferredRun =
    productionRuns.find((run) => run.status === "completed") ??
    productionRuns[0];
  const [runId, setRunId] = useState(preferredRun?.id ?? "");
  const [tableId, setTableId] = useState(snapshot.tables[0]?.id ?? "");
  const [rows, setRows] = useState<TableRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!productionRuns.some((run) => run.id === runId))
      setRunId(preferredRun?.id ?? "");
  }, [preferredRun?.id, productionRuns, runId]);

  useEffect(() => {
    if (!snapshot.tables.some((table) => table.id === tableId)) {
      setTableId(snapshot.tables[0]?.id ?? "");
    }
  }, [snapshot.tables, tableId]);

  const load = useCallback(
    async (after?: string) => {
      if (!runId || !tableId) return;
      setLoading(true);
      setError("");
      try {
        const page = await api.getTableRows(tableId, runId, after);
        setRows((current) => (after ? [...current, ...page.rows] : page.rows));
        setCursor(page.next_cursor);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Rows could not be loaded",
        );
      } finally {
        setLoading(false);
      }
    },
    [runId, tableId],
  );

  useEffect(() => {
    setRows([]);
    setCursor(null);
    void load();
  }, [load]);

  if (!productionRuns.length) {
    return <EmptyState icon={<Table2 size={21} />} title="No production run" />;
  }
  if (!snapshot.tables.length) {
    return <EmptyState icon={<Rows3 size={21} />} title="No formal tables" />;
  }

  return (
    <div className="view-stack">
      <section className="view-heading">
        <div>
          <p className="eyebrow">Committed data</p>
          <h2>Formal tables</h2>
        </div>
        <StatusPill value={`${rows.length} rows`} />
      </section>
      <div className="table-controls">
        <label>
          Run
          <select
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
          >
            {productionRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {label(run.status)} - {formatTime(run.created_at)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Table
          <select
            value={tableId}
            onChange={(event) => setTableId(event.target.value)}
          >
            {snapshot.tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p className="inline-error">
          <CircleAlert size={15} />
          {error}
        </p>
      ) : null}
      <DataGrid
        rows={rows.map((row) => ({
          ...row.data,
          source_url: row.provenance.source_url,
        }))}
      />
      {cursor ? (
        <button
          className="button button--secondary button--small load-more"
          type="button"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          {loading ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Plus size={15} />
          )}
          Load more
        </button>
      ) : null}
    </div>
  );
}
