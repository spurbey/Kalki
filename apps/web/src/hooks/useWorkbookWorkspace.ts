import type {
  AnswerQuestionInput,
  WorkbookEvent,
  WorkbookSnapshot,
} from "@kalki/contracts";
import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import type { WorkspaceView } from "../components/WorkspacePane.js";
import { taskSlug } from "../views/TaskView.js";

const WORKBOOK_STORAGE_KEY = "kalki.activeWorkbookId";

export function useWorkbookWorkspace() {
  const [workbookId, setWorkbookId] = useState(
    () => localStorage.getItem(WORKBOOK_STORAGE_KEY) ?? "",
  );
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot | null>(null);
  const [events, setEvents] = useState<WorkbookEvent[]>([]);
  const [health, setHealth] = useState({ api: false, trueforge: false });
  const [streamStatus, setStreamStatus] =
    useState<api.StreamStatus>("connecting");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("research");
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
    let active = true;
    setLoading(true);
    setError("");
    void api
      .getWorkbook(workbookId)
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Workbook could not be loaded",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
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
        if (
          event.type === "agent.turn.created" &&
          typeof event.payload.turn_id === "string"
        ) {
          setActiveTurnId(event.payload.turn_id);
        }
        if (event.type === "agent.turn.done") {
          setActiveTurnId(null);
          window.setTimeout(() => void refresh(), 300);
          window.setTimeout(() => void refresh(), 1200);
        }
        if (event.type === "table.batch_published") void refresh();
      },
      setStreamStatus,
    );
  }, [refresh, workbookId]);

  const createWorkbook = async (title: string) => {
    setError("");
    try {
      const workbook = await api.createWorkbook({ title });
      localStorage.setItem(WORKBOOK_STORAGE_KEY, workbook.id);
      setWorkbookId(workbook.id);
      setActiveView("research");
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
    if (!workbookId || !snapshot) return;
    setBusy(true);
    setError("");
    try {
      if (!snapshot.tasks.length) {
        const task = await api.createTask(workbookId, {
          slug: taskSlug(snapshot.workbook.title),
          title: snapshot.workbook.title,
          objective: message,
        });
        setSnapshot((current) =>
          current?.workbook.id === workbookId
            ? { ...current, tasks: [task] }
            : current,
        );
      }
      const turn = await api.createTurn(workbookId, { input: message });
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

  return {
    activeTurnId,
    activeView,
    answer,
    busy,
    connect,
    createWorkbook,
    dismissError: () => setError(""),
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
  };
}
