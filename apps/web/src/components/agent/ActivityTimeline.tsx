import {
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  MessageSquare,
  XCircle,
} from "lucide-react";
import Markdown from "markdown-to-jsx";
import type { ActivityItem } from "../../lib/activity.js";
import { formatTime } from "../../lib/format.js";

function Marker({ item }: { item: ActivityItem }) {
  if (item.kind === "assistant") return <Bot size={14} />;
  if (item.kind === "user") return <MessageSquare size={14} />;
  if (item.kind === "error" || item.status === "error")
    return <XCircle size={14} />;
  if (item.status === "running")
    return <LoaderCircle className="spin" size={14} />;
  if (item.kind === "tool") return <Check size={14} />;
  return <CheckCircle2 size={14} />;
}

export function ActivityTimeline({ items }: { items: ActivityItem[] }) {
  return items.map((item) => {
    if (item.kind === "reasoning") {
      return (
        <article
          key={item.key}
          className="activity-item activity-item--reasoning"
        >
          <div className="activity-item__marker">
            <BrainCircuit size={14} />
          </div>
          <details className="activity-item__reasoning">
            <summary>
              <strong>{item.title}</strong>
              <span>View reasoning</span>
              <time>{formatTime(item.timestamp)}</time>
            </summary>
            <p>{item.text}</p>
          </details>
        </article>
      );
    }

    return (
      <article
        key={item.key}
        className={`activity-item activity-item--${item.kind}`}
      >
        <div className="activity-item__marker">
          <Marker item={item} />
        </div>
        <div className="activity-item__body">
          <div className="activity-item__meta">
            <strong>{item.title}</strong>
            {item.kind === "tool" ? (
              <span className="activity-item__summary">{item.text}</span>
            ) : null}
            {item.count && item.count > 1 ? (
              <span className="activity-item__count">x{item.count}</span>
            ) : null}
            <time>{formatTime(item.timestamp)}</time>
          </div>
          {item.kind === "assistant" ? (
            <div className="activity-item__content">
              <Markdown options={{ disableParsingRawHTML: true }}>
                {item.text}
              </Markdown>
            </div>
          ) : item.kind !== "tool" ? (
            <p>{item.text}</p>
          ) : null}
          {item.detail ? (
            <details className="activity-item__details">
              <summary title="Show details" aria-label="Show details">
                <ChevronRight size={12} />
              </summary>
              <pre>{item.detail}</pre>
            </details>
          ) : null}
        </div>
      </article>
    );
  });
}
