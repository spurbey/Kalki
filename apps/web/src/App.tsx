import {
  CircleAlert,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Table2,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { AgentPane } from "./components/AgentPane.js";
import { StatusPill } from "./components/common.js";
import { WorkspacePane } from "./components/WorkspacePane.js";
import { useWorkbookWorkspace } from "./hooks/useWorkbookWorkspace.js";
import { label } from "./lib/format.js";

function NewWorkbook({
  onCreate,
}: {
  onCreate: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onCreate(title.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="create-workbook">
      <div className="create-workbook__mark">K</div>
      <form className="create-workbook__form" onSubmit={submit}>
        <p className="eyebrow">Kalki workbook</p>
        <h1>Start a research workspace</h1>
        <label>
          Workbook title
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Tesla price research"
            maxLength={200}
          />
        </label>
        <button
          className="button button--primary"
          type="submit"
          disabled={busy || !title.trim()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Plus size={17} />
          )}
          Create workbook
        </button>
      </form>
    </main>
  );
}

export function App() {
  const {
    activeTurnId,
    activeView,
    answer,
    busy,
    connect,
    createWorkbook,
    dismissError,
    error,
    events,
    health,
    loading,
    mobilePane,
    refresh,
    send,
    setActiveView,
    setMobilePane,
    snapshot,
    startNewWorkbook,
    streamStatus,
    workbookId,
  } = useWorkbookWorkspace();

  if (!workbookId) {
    return (
      <>
        <NewWorkbook onCreate={createWorkbook} />
        {error ? (
          <div className="toast toast--error">
            <CircleAlert size={16} />
            {error}
          </div>
        ) : null}
      </>
    );
  }

  if (loading || !snapshot) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" size={26} />
        <span>{error || "Loading workbook"}</span>
        {error ? (
          <button
            className="button button--secondary button--small"
            type="button"
            onClick={startNewWorkbook}
          >
            New workbook
          </button>
        ) : null}
      </main>
    );
  }

  const task = snapshot.tasks[0] ?? null;
  const activeRun = [...snapshot.runs].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  )[0];
  const connected = Boolean(snapshot.workbook.trueforge_session_id);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">K</span>
          <div>
            <strong>{snapshot.workbook.title}</strong>
            <span>Kalki</span>
          </div>
        </div>
        <div className="topbar__status">
          {task ? (
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
          ) : (
            <StatusPill value="No task" tone="warn" />
          )}
          {activeRun ? (
            <span className="run-summary">
              <span>{activeRun.mode}</span>
              {label(activeRun.status)}
            </span>
          ) : null}
          <span
            className={
              connected && health.trueforge
                ? "connection connection--good"
                : "connection"
            }
          >
            <span />
            {!health.api
              ? "API offline"
              : connected && health.trueforge
                ? "TrueForge connected"
                : "TrueForge disconnected"}
          </span>
        </div>
        <div className="topbar__actions">
          <button
            className="icon-button"
            type="button"
            title="Refresh workbook"
            aria-label="Refresh workbook"
            onClick={() => void refresh()}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="New workbook"
            aria-label="New workbook"
            onClick={startNewWorkbook}
          >
            <Plus size={18} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-banner">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button
            type="button"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={dismissError}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}

      <div className="mobile-switch" role="tablist" aria-label="Workspace pane">
        <button
          type="button"
          className={mobilePane === "agent" ? "mobile-switch__active" : ""}
          onClick={() => setMobilePane("agent")}
        >
          <MessageSquare size={15} />
          Agent
        </button>
        <button
          type="button"
          className={mobilePane === "workbook" ? "mobile-switch__active" : ""}
          onClick={() => setMobilePane("workbook")}
        >
          <Table2 size={15} />
          Workbook
        </button>
      </div>

      <div className="workspace-shell">
        <div
          className={
            mobilePane === "agent"
              ? "workspace-shell__agent workspace-shell__mobile-active"
              : "workspace-shell__agent"
          }
        >
          <AgentPane
            snapshot={snapshot}
            events={events}
            streamStatus={streamStatus}
            activeTurnId={activeTurnId}
            busy={busy}
            onConnect={connect}
            onSend={send}
            onAnswer={answer}
          />
        </div>
        <div
          className={
            mobilePane === "workbook"
              ? "workspace-shell__book workspace-shell__mobile-active"
              : "workspace-shell__book"
          }
        >
          <WorkspacePane
            snapshot={snapshot}
            activeView={activeView}
            onViewChange={setActiveView}
            onRefresh={refresh}
          />
        </div>
      </div>
    </main>
  );
}
