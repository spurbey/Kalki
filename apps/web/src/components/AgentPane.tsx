import type {
  AnswerQuestionInput,
  WorkbookEvent,
  WorkbookSnapshot,
} from "@kalki/contracts";
import {
  Bot,
  Link2,
  LoaderCircle,
  Send,
  Unplug,
  Wifi,
} from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StreamStatus } from "../api.js";
import { activityFromEvents } from "../lib/activity.js";
import { label } from "../lib/format.js";
import { ActivityTimeline } from "./agent/ActivityTimeline.js";
import { QuestionPrompt } from "./agent/QuestionPrompt.js";
import { EmptyState } from "./common.js";
import { WorkflowProgress } from "./WorkflowProgress.js";

export function AgentPane({
  snapshot,
  events,
  streamStatus,
  activeTurnId,
  busy,
  onConnect,
  onSend,
  onAnswer,
}: {
  snapshot: WorkbookSnapshot;
  events: WorkbookEvent[];
  streamStatus: StreamStatus;
  activeTurnId: string | null;
  busy: boolean;
  onConnect: () => Promise<void>;
  onSend: (message: string) => Promise<void>;
  onAnswer: (
    answer: string,
    decision: AnswerQuestionInput["decision"],
  ) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const activity = useMemo(() => activityFromEvents(events), [events]);
  const connected = Boolean(snapshot.workbook.trueforge_session_id);
  const pending = snapshot.pending_question;
  const turnRunning = Boolean(activeTurnId);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activity.length, pending?.id]);

  const submit = async () => {
    const next = message.trim();
    if (!next) return;
    setMessage("");
    try {
      await onSend(next);
    } catch {
      setMessage(next);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="agent-pane">
      <header className="pane-header">
        <div>
          <p className="eyebrow">Kalki agent</p>
          <h2>{snapshot.tasks[0]?.title ?? "New research task"}</h2>
        </div>
        <span className={`stream-state stream-state--${streamStatus}`}>
          {streamStatus === "live" ? (
            <Wifi size={14} />
          ) : (
            <LoaderCircle className="spin" size={14} />
          )}
          {streamStatus === "live" ? "Live" : label(streamStatus)}
        </span>
      </header>

      <WorkflowProgress task={snapshot.tasks[0] ?? null} />

      <div className="activity-feed">
        {!connected ? (
          <div className="connect-state">
            <Unplug size={24} />
            <strong>TrueForge not connected</strong>
            <button
              className="button button--primary button--small"
              type="button"
              onClick={onConnect}
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Link2 size={15} />
              )}
              Connect
            </button>
          </div>
        ) : activity.length === 0 ? (
          <EmptyState icon={<Bot size={21} />} title="No agent activity" />
        ) : (
          <ActivityTimeline items={activity} />
        )}
        {pending ? (
          <QuestionPrompt question={pending} busy={busy} onAnswer={onAnswer} />
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <textarea
          name="message"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            pending
              ? "Answer the pending question above"
              : turnRunning
                ? "Agent is working"
                : "Message Kalki"
          }
          disabled={!connected || Boolean(pending) || turnRunning || busy}
          maxLength={32_768}
        />
        <button
          className="icon-button icon-button--primary"
          type="button"
          title="Send message"
          aria-label="Send message"
          onClick={() => void submit()}
          disabled={
            !message.trim() ||
            !connected ||
            Boolean(pending) ||
            turnRunning ||
            busy
          }
        >
          {turnRunning || busy ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Send size={18} />
          )}
        </button>
      </div>
    </section>
  );
}
