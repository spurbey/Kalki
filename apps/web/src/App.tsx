import type {
  AnswerQuestionInput,
  WorkbookEvent,
  WorkbookSnapshot,
} from "@kalki/contracts";
import {
  CircleAlert,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Table2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import * as api from "./api.js";
import { AgentPane } from "./components/AgentPane.js";
import { StatusPill } from "./components/common.js";
import {
  WorkspacePane,
  type WorkspaceView,
} from "./components/WorkspacePane.js";
import { label } from "./lib/format.js";

const WORKBOOK_STORAGE_KEY = "kalki.activeWorkbookId";

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
  const [workbookId, setWorkbookId] = useState(
    () => localStorage.getItem(WORKBOOK_STORAGE_KEY) ?? "",
  );
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot | null>(null);
  const [events, setEvents] = useState<WorkbookEvent[]>([]);
  const [health, setHealth] = useState({ api: false, trueforge: false });
  const [streamStatus, setStreamStatus] =
    useState<api.StreamStatus>("connecting");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("task");
  const [mobilePane, setMobilePane] = useState<"agent" | "workbook">("agent");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(workbookId));
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!workbookId) return;
    setSnapshot(await api.getWorkbook(workbookId));
  }, [workbookId]);

  useEffect(() => {
    void api
      .getHealth()
      .then((result) => setHealth({ api: true, trueforge: result.trueforge }))
      .catch(() => setHealth({ api: false, trueforge: false }));
  }, []);

  useEffect(() => {
    if (!workbookId) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    void api
      .getWorkbook(workbookId)
      .then(setSnapshot)
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Workbook could not be loaded",
        ),
      )
      .finally(() => setLoading(false));
  }, [workbookId]);

  useEffect(() => {
    if (!workbookId) return;
    setEvents([]);
    return api.subscribeWorkbookEvents(
      workbookId,
      (event) => {
        setEvents((current) =>
          current.some((candidate) => candidate.seq === event.seq)
            ? current
            : [...current, event],
        );
        if (event.type === "agent.turn.done") {
          setActiveTurnId(null);
          window.setTimeout(() => void refresh(), 300);
          window.setTimeout(() => void refresh(), 1200);
        }
      },
      setStreamStatus,
    );
  }, [refresh, workbookId]);

  const createWorkbook = async (title: string) => {
    setError("");
    try {
      const workbook = await api.createWorkbook(title);
      localStorage.setItem(WORKBOOK_STORAGE_KEY, workbook.id);
      setWorkbookId(workbook.id);
      setActiveView("task");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Workbook creation failed",
      );
      throw cause;
    }
  };

  const connect = async () => {
    if (!workbookId) return;
    setBusy(true);
    setError("");
    try {
      await api.connectWorkbook(workbookId);
      await refresh();
      const result = await api.getHealth();
      setHealth({ api: true, trueforge: result.trueforge });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "TrueForge connection failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const send = async (message: string) => {
    if (!workbookId) return;
    setBusy(true);
    setError("");
    try {
      const turn = await api.createTurn(workbookId, message);
      setActiveTurnId(turn.status === "running" ? turn.id : null);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Message could not be sent",
      );
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const answer = async (
    answerText: string,
    decision: AnswerQuestionInput["decision"],
  ) => {
    if (!workbookId || !snapshot?.pending_question) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.answerQuestion(
        workbookId,
        snapshot.pending_question,
        answerText,
        decision,
      );
      setSnapshot(next);
      setActiveTurnId(next.workbook.current_trueforge_turn_id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Answer could not be submitted",
      );
    } finally {
      setBusy(false);
    }
  };

  const startNewWorkbook = () => {
    localStorage.removeItem(WORKBOOK_STORAGE_KEY);
    setWorkbookId("");
    setSnapshot(null);
    setEvents([]);
    setActiveTurnId(null);
    setError("");
  };

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
            onClick={() => setError("")}
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
