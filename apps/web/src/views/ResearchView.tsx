import type { BrowserInteractionInput, BrowserStatus } from "@kalki/contracts";
import { ArrowRight, Globe2, LoaderCircle, RefreshCw } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as api from "../api.js";

const supportedBrowserKeys = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Escape",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

function browserPoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
) {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(
    bounds.width / image.naturalWidth,
    bounds.height / image.naturalHeight,
  );
  const renderedWidth = image.naturalWidth * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const x = clientX - bounds.left - offsetX;
  const y = clientY - bounds.top;
  if (x < 0 || y < 0 || x > renderedWidth || y > image.naturalHeight * scale) {
    return null;
  }
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

function clampDelta(value: number) {
  return Math.max(-10_000, Math.min(10_000, Math.round(value)));
}

export function ResearchView() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [url, setUrl] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const statusRequest = useRef(0);
  const imageRef = useRef<HTMLImageElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const interactionQueue = useRef<Promise<void>>(Promise.resolve());
  const textBuffer = useRef("");
  const textTimer = useRef<number | null>(null);
  const wheelBuffer = useRef({ x: 0, y: 0, deltaX: 0, deltaY: 0 });
  const wheelTimer = useRef<number | null>(null);
  const screenshotTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    try {
      const next = await api.getBrowserStatus();
      if (request !== statusRequest.current) return;
      setStatus(next);
      setError("");
    } catch {
      if (request !== statusRequest.current) return;
      setStatus(null);
      setError("Shared browser is unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const refreshScreenshot = useCallback(() => {
    if (screenshotTimer.current !== null) {
      window.clearTimeout(screenshotTimer.current);
      screenshotTimer.current = null;
    }
    setVersion(Date.now());
  }, []);

  const scheduleScreenshot = useCallback((delay: number) => {
    if (screenshotTimer.current !== null) {
      window.clearTimeout(screenshotTimer.current);
    }
    screenshotTimer.current = window.setTimeout(() => {
      screenshotTimer.current = null;
      setVersion(Date.now());
    }, delay);
  }, []);

  const queueInteraction = useCallback((input: BrowserInteractionInput) => {
    interactionQueue.current = interactionQueue.current.then(async () => {
      const request = ++statusRequest.current;
      try {
        const next = await api.interactBrowser(input);
        if (request !== statusRequest.current) return;
        setStatus(next);
        refreshScreenshot();
        setError("");
      } catch (cause) {
        if (request !== statusRequest.current) return;
        setError(
          cause instanceof Error ? cause.message : "Browser interaction failed",
        );
      }
    });
  }, [refreshScreenshot]);

  const flushText = useCallback(() => {
    if (textTimer.current !== null) window.clearTimeout(textTimer.current);
    textTimer.current = null;
    const text = textBuffer.current;
    textBuffer.current = "";
    if (text) queueInteraction({ action: "type", text });
  }, [queueInteraction]);

  useEffect(
    () => () => {
      if (textTimer.current !== null) window.clearTimeout(textTimer.current);
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
      if (screenshotTimer.current !== null) {
        window.clearTimeout(screenshotTimer.current);
      }
    },
    [],
  );

  const navigate = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    const request = ++statusRequest.current;
    try {
      const next = await api.navigateBrowser({ url: url.trim() });
      if (request !== statusRequest.current) return;
      setStatus(next);
      setUrl("");
      refreshScreenshot();
      setError("");
    } catch (cause) {
      if (request !== statusRequest.current) return;
      setError(cause instanceof Error ? cause.message : "Navigation failed");
    } finally {
      setBusy(false);
    }
  };

  const available = status?.available === true;

  const clickBrowser = (event: MouseEvent<HTMLDivElement>) => {
    if (!imageRef.current) return;
    const point = browserPoint(imageRef.current, event.clientX, event.clientY);
    if (!point) return;
    screenRef.current?.focus();
    queueInteraction({ action: "click", ...point });
  };

  const scrollBrowser = (event: WheelEvent<HTMLDivElement>) => {
    if (!imageRef.current) return;
    const point = browserPoint(imageRef.current, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    wheelBuffer.current = {
      x: point.x,
      y: point.y,
      deltaX: clampDelta(wheelBuffer.current.deltaX + event.deltaX),
      deltaY: clampDelta(wheelBuffer.current.deltaY + event.deltaY),
    };
    if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => {
      const pending = wheelBuffer.current;
      wheelBuffer.current = { x: 0, y: 0, deltaX: 0, deltaY: 0 };
      wheelTimer.current = null;
      queueInteraction({
        action: "scroll",
        x: pending.x,
        y: pending.y,
        delta_x: pending.deltaX,
        delta_y: pending.deltaY,
      });
    }, 80);
  };

  const typeInBrowser = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "v") return;
      if (event.key.length !== 1) return;
      event.preventDefault();
      flushText();
      queueInteraction({
        action: "key",
        key: `${event.metaKey ? "Meta" : "Control"}+${event.key.toUpperCase()}`,
      });
      return;
    }
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      textBuffer.current += event.key;
      if (textTimer.current !== null) window.clearTimeout(textTimer.current);
      textTimer.current = window.setTimeout(flushText, 80);
      return;
    }
    if (!supportedBrowserKeys.has(event.key)) return;
    event.preventDefault();
    flushText();
    queueInteraction({
      action: "key",
      key: event.shiftKey ? `Shift+${event.key}` : event.key,
    });
  };

  return (
    <div className="research-view">
      <header className="view-heading research-heading">
        <div>
          <p className="eyebrow">Shared browser</p>
          <h2>Research</h2>
        </div>
        <div className="browser-state">
          <span
            className={
              available ? "browser-dot browser-dot--live" : "browser-dot"
            }
          />
          {available
            ? `${status.tab_count} tab${status.tab_count === 1 ? "" : "s"}`
            : "Offline"}
          <button
            className="icon-button"
            type="button"
            title="Refresh browser"
            aria-label="Refresh browser"
            onClick={() => {
              refreshScreenshot();
              void refresh();
            }}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      <form className="browser-toolbar" onSubmit={navigate}>
        <Globe2 size={17} />
        <input
          type="url"
          name="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={status?.url ?? "https://example.com"}
          aria-label="Browser URL"
          disabled={busy}
        />
        <button
          className="icon-button icon-button--primary"
          type="submit"
          title="Navigate"
          aria-label="Navigate"
          disabled={busy || !url.trim()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <ArrowRight size={17} />
          )}
        </button>
      </form>

      {error || status?.error ? (
        <div className="browser-unavailable">
          <Globe2 size={24} />
          <strong>{error || "Playwright MCP is unavailable"}</strong>
        </div>
      ) : available ? (
        <div className="browser-frame">
          <div className="browser-frame__meta">
            <strong>{status.title || "Untitled page"}</strong>
            <span>{status.url || "about:blank"}</span>
          </div>
          <div
            ref={screenRef}
            className="browser-frame__screen"
            role="application"
            tabIndex={0}
            aria-label="Interactive shared browser"
            onClick={clickBrowser}
            onWheel={scrollBrowser}
            onKeyDown={typeInBrowser}
            onPaste={(event) => {
              event.preventDefault();
              textBuffer.current += event.clipboardData.getData("text");
              flushText();
            }}
          >
            <img
              ref={imageRef}
              src={api.browserScreenshotUrl(version)}
              alt={status.title || "Shared browser page"}
              draggable={false}
              onLoad={() => scheduleScreenshot(1_200)}
              onError={() => scheduleScreenshot(2_500)}
            />
          </div>
        </div>
      ) : (
        <div className="browser-unavailable">
          <LoaderCircle className="spin" size={24} />
          <strong>Connecting to browser</strong>
        </div>
      )}
    </div>
  );
}
