import type { Task, TaskState } from "@kalki/contracts";
import { Check, Circle, LoaderCircle } from "lucide-react";

const stages = ["Plan", "Research", "Build", "Test", "Publish"];

function stageIndex(state: TaskState): number {
  if (state === "aligning" || state === "awaiting_task_confirmation") return 0;
  if (state === "exploring" || state === "awaiting_schema_review") return 1;
  if (state === "building") return 2;
  if (state === "testing" || state === "awaiting_production_confirmation")
    return 3;
  return 4;
}

export function WorkflowProgress({ task }: { task: Task | null }) {
  if (!task) return null;
  const current = stageIndex(task.state);

  return (
    <section className="workflow-progress" aria-label="Workflow progress">
      <div className="workflow-progress__heading">
        <strong>Progress</strong>
        <span>
          {Math.min(current + 1, stages.length)}/{stages.length}
        </span>
      </div>
      <ol>
        {stages.map((stage, index) => {
          const done = index < current || task.state === "completed";
          const active = index === current && !done;
          return (
            <li
              key={stage}
              className={
                done
                  ? "workflow-stage--done"
                  : active
                    ? "workflow-stage--active"
                    : ""
              }
            >
              {done ? (
                <Check size={13} />
              ) : active ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Circle size={11} />
              )}
              <span>{stage}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
