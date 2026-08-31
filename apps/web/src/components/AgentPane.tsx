import type {
  AgentQuestion,
  AnswerQuestionInput,
  WorkbookEvent,
  WorkbookSnapshot,
} from "@kalki/contracts";
import {
  Activity,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleAlert,
  Link2,
  LoaderCircle,
  MessageSquare,
  Send,
  Unplug,
  Wifi,
  XCircle,
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
import { formatTime, label } from "../lib/format.js";
import { EmptyState } from "./common.js";
import { WorkflowProgress } from "./WorkflowProgress.js";

function QuestionPrompt({
  question,
  busy,
  onAnswer,
}: {
  question: AgentQuestion;
  busy: boolean;
  onAnswer: (
    answer: string,
    decision: AnswerQuestionInput["decision"],
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<{
    answer: string;
    decision: AnswerQuestionInput["decision"];
  } | null>(null);
  const [custom, setCustom] = useState("");
  const allowsCustom = question.gate_kind === "clarification";
  const reviewDecisions: AnswerQuestionInput["decision"][] = [
    "approve",
    "revise",
    "cancel",
  ];
  const choices = question.options.map((answer, index) => {
    const decision = allowsCustom
      ? "free_text"
      : (reviewDecisions[index] ?? "revise");
    return {
      answer,
      decision,
      disabled:
        question.gate_kind === "production_review" &&
        !question.run_id &&
        decision === "approve",
    };
  });
  const answer = custom.trim() || selected?.answer || "";
  const decision = custom.trim() ? "free_text" : selected?.decision;

  useEffect(() => {
    setSelected(null);
    setCustom("");
  }, [question.id]);

  return (
    <section className="question-prompt">
      <div className="question-prompt__header">
        <CircleAlert size={17} />
        <span>{label(question.gate_kind)}</span>
      </div>
      <p>{question.question_text}</p>
      {question.options.length ? (
        <div className="question-options">
          {choices.map((choice) => (
            <button
              key={choice.answer}
              type="button"
              className={
                selected?.answer === choice.answer
                  ? "question-option question-option--selected"
                  : "question-option"
              }
              onClick={() => {
                setSelected(choice);
                setCustom("");
              }}
              disabled={busy || choice.disabled}
              title={
                choice.disabled
                  ? "Create the production run before approving it"
                  : undefined
              }
            >
              <span className="question-option__radio">
                {selected?.answer === choice.answer ? (
                  <Check size={12} />
                ) : null}
              </span>
              {choice.answer}
            </button>
          ))}
        </div>
      ) : null}
      {allowsCustom ? (
        <textarea
          name="answer"
          rows={2}
          value={custom}
          onChange={(event) => {
            setCustom(event.target.value);
            setSelected(null);
          }}
          placeholder="Type your answer"
          disabled={busy}
        />
      ) : null}
      <button
        className="button button--primary button--small"
        type="button"
        disabled={busy || !answer || !decision}
        onClick={() => decision && onAnswer(answer, decision)}
      >
        {busy ? (
          <LoaderCircle className="spin" size={15} />
        ) : (
          <Send size={15} />
        )}
        Submit answer
      </button>
    </section>
  );
}

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
          <p className="eyebrow">TrueForge coordinator</p>
          <h2>Agent activity</h2>
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
          activity.map((item) => (
            <article
              key={item.key}
              className={`activity-item activity-item--${item.kind}`}
            >
              <div className="activity-item__marker">
                {item.kind === "assistant" ? <Bot size={15} /> : null}
                {item.kind === "reasoning" ? <BrainCircuit size={15} /> : null}
                {item.kind === "user" ? <MessageSquare size={15} /> : null}
                {item.kind === "tool" ? <Activity size={15} /> : null}
                {item.kind === "error" ? <XCircle size={15} /> : null}
                {item.kind === "status" && item.status === "running" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : null}
                {item.kind === "status" && item.status !== "running" ? (
                  <CheckCircle2 size={15} />
                ) : null}
              </div>
              <div className="activity-item__body">
                <div className="activity-item__meta">
                  <strong>{item.title}</strong>
                  <time>{formatTime(item.timestamp)}</time>
                </div>
                <p>{item.text}</p>
                {item.detail ? (
                  <details>
                    <summary>Details</summary>
                    <pre>{item.detail}</pre>
                  </details>
                ) : null}
              </div>
            </article>
          ))
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
