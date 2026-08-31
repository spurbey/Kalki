import type { Run } from "@kalki/contracts";
import { Activity } from "lucide-react";
import { EmptyState, StatusPill } from "../components/common.js";
import { formatTime, label, shortHash } from "../lib/format.js";

export function RunsView({ runs }: { runs: Run[] }) {
  if (!runs.length)
    return <EmptyState icon={<Activity size={21} />} title="No runs" />;

  return (
    <div className="view-stack">
      <section className="view-heading">
        <div>
          <p className="eyebrow">Execution history</p>
          <h2>Runs</h2>
        </div>
        <StatusPill value={`${runs.length} runs`} />
      </section>
      <div className="run-list">
        {[...runs]
          .sort((left, right) =>
            right.created_at.localeCompare(left.created_at),
          )
          .map((run) => (
            <article className="run-row" key={run.id}>
              <div className="run-row__main">
                <span className={`run-mode run-mode--${run.mode}`}>
                  {run.mode}
                </span>
                <div>
                  <strong>{label(run.status)}</strong>
                  <p className="mono">{run.id}</p>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Rows</dt>
                  <dd>{run.published_row_count}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatTime(run.created_at)}</dd>
                </div>
                <div>
                  <dt>Pipeline</dt>
                  <dd className="mono">{shortHash(run.pipeline_hash)}</dd>
                </div>
              </dl>
              {run.error ? (
                <p className="run-row__error">{run.error.message}</p>
              ) : null}
            </article>
          ))}
      </div>
    </div>
  );
}
