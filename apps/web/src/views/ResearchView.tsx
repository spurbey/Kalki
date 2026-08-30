import type { BrowserStatus } from "@kalki/contracts";
import { ArrowRight, Globe2, LoaderCircle, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import * as api from "../api.js";

export function ResearchView() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [url, setUrl] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await api.getBrowserStatus();
      setStatus(next);
      setVersion(Date.now());
      setError("");
    } catch {
      setStatus(null);
      setError("Shared browser is unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const navigate = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const next = await api.navigateBrowser({ url: url.trim() });
      setStatus(next);
      setUrl("");
      setVersion(Date.now());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Navigation failed");
    } finally {
      setBusy(false);
    }
  };

  const available = status?.available === true;

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
            onClick={() => void refresh()}
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
          <img
            src={api.browserScreenshotUrl(version)}
            alt={status.title || "Shared browser page"}
          />
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
