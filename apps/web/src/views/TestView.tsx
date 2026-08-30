import type { RecordEnvelope, Run } from "@kalki/contracts";
import { CircleAlert, FlaskConical } from "lucide-react";
import { DataGrid, EmptyState, StatusPill } from "../components/common.js";
import { formatTime, label, shortHash } from "../lib/format.js";

export function TestView({ runs }: { runs: Run[] }) {
  const run = [...runs]
    .filter((candidate) => candidate.mode === "test")
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
  if (!run)
    return <EmptyState icon={<FlaskConical size={21} />} title="No test run" />;

  const samples = run.test_samples ?? {};
  return (
    <div className="view-stack">
      <section className="view-heading">
        <div>
          <p className="eyebrow">Sandbox-only sample</p>
          <h2>Test run</h2>
        </div>
        <StatusPill
          value={run.status}
          tone={
            run.status === "completed"
              ? "good"
              : run.status === "failed"
                ? "bad"
                : "warn"
          }
        />
      </section>
      <dl className="fact-grid">
        <div>
          <dt>Run</dt>
          <dd className="mono">{run.id}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>
            {run.finished_at ? formatTime(run.finished_at) : "In progress"}
          </dd>
        </div>
        <div>
          <dt>Task hash</dt>
          <dd className="mono">{shortHash(run.task_hash)}</dd>
        </div>
        <div>
          <dt>Pipeline hash</dt>
          <dd className="mono">{shortHash(run.pipeline_hash)}</dd>
        </div>
      </dl>
      {Object.entries(samples).map(([table, envelopes]) => (
        <section className="flat-section" key={table}>
          <div className="flat-section__heading">
            <h3>{label(table)}</h3>
            <span>{envelopes.length} sample rows</span>
          </div>
          <DataGrid
            rows={(envelopes as RecordEnvelope[]).map(
              (envelope) => envelope.data,
            )}
          />
        </section>
      ))}
      {run.error ? (
        <p className="inline-error">
          <CircleAlert size={15} />
          {run.error.message}
        </p>
      ) : null}
    </div>
  );
}
