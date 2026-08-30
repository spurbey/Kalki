import type { Task } from "@kalki/contracts";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import * as api from "../api.js";
import { shortHash } from "../lib/format.js";
import { StatusPill } from "../components/common.js";

export function TaskView({
  task,
  workbookId,
  onRefresh,
}: {
  task: Task | null;
  workbookId: string;
  onRefresh: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (task) {
    return (
      <div className="view-stack">
        <section className="view-heading">
          <div>
            <p className="eyebrow">Task contract</p>
            <h2>{task.title}</h2>
          </div>
          <StatusPill
            value={task.state}
            tone={
              task.state === "completed"
                ? "good"
                : task.state === "failed"
                  ? "bad"
                  : "neutral"
            }
          />
        </section>
        <dl className="fact-grid">
          <div>
            <dt>Slug</dt>
            <dd>{task.slug}</dd>
          </div>
          <div>
            <dt>Hash</dt>
            <dd className="mono">{shortHash(task.task_hash)}</dd>
          </div>
          <div className="fact-grid__wide">
            <dt>Objective</dt>
            <dd>{task.objective}</dd>
          </div>
        </dl>
        <section className="flat-section">
          <h3>Registered task</h3>
          <pre className="document-preview">
            {task.task_markdown ?? "Waiting for the agent to register task.md."}
          </pre>
        </section>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) return;
    setBusy(true);
    setError("");
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "research-task";
    try {
      await api.createTask(workbookId, {
        slug,
        title: title.trim(),
        objective: objective.trim(),
      });
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Task creation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="task-form" onSubmit={submit}>
      <div>
        <p className="eyebrow">New task</p>
        <h2>Define the research request</h2>
      </div>
      <label>
        Task title
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Find Tesla's highest daily prices"
          maxLength={200}
        />
      </label>
      <label>
        Objective
        <textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Collect TSLA daily history from 2025 onward and return the three highest daily highs."
          rows={5}
          maxLength={10_000}
        />
      </label>
      {error ? (
        <p className="inline-error">
          <CircleAlert size={15} />
          {error}
        </p>
      ) : null}
      <button
        className="button button--primary"
        type="submit"
        disabled={busy || !title.trim() || !objective.trim()}
      >
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Check size={17} />
        )}
        Create task
      </button>
    </form>
  );
}
