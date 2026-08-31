import {
  BrowserRunCodeInputSchema,
  PlaywrightToolResultSchema,
  type BrowserInteractionInput,
  type BrowserStatus,
  type PlaywrightToolResult,
} from "@kalki/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../config.js";

type BrowserTab = {
  index: number;
  title: string;
  url: string;
  current: boolean;
};

const unavailableStatus: BrowserStatus = {
  available: false,
  url: null,
  title: null,
  tab_count: 0,
  screenshot_at: null,
  error: null,
};

function resultText(result: PlaywrightToolResult): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
}

function resultImage(result: PlaywrightToolResult): Buffer | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const image = content.find((item) => item.type === "image");
  return image ? Buffer.from(image.data, "base64") : null;
}

function parseTabs(text: string): BrowserTab[] {
  const tabs: BrowserTab[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^- (\d+): (\(current\) )?\[(.*)\]\((.*)\)$/);
    if (!match) continue;
    tabs.push({
      index: Number(match[1]),
      current: Boolean(match[2]),
      title: match[3] ?? "",
      url: match[4] ?? "",
    });
  }
  return tabs;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}

export class PlaywrightBrowser {
  private client: Client | null = null;
  private connection: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private screenshotAt: string | null = null;

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async keepAlive(): Promise<void> {
    await this.status();
  }

  async status(): Promise<BrowserStatus> {
    return this.serialize(async () => {
      try {
        await this.connect();
        const tabs = await this.readTabs();
        const aligned = await this.alignResearchTab(tabs);
        const current = aligned.find((tab) => tab.current) ?? aligned[0];
        const status: BrowserStatus = {
          available: true,
          url: current?.url ? current.url.slice(0, 4000) : null,
          title: current?.title ? current.title.slice(0, 1000) : null,
          tab_count: aligned.length,
          screenshot_at: this.screenshotAt,
          error: null,
        };
        return status;
      } catch (error) {
        this.disconnect();
        return {
          ...unavailableStatus,
          screenshot_at: this.screenshotAt,
          error: errorMessage(error),
        };
      }
    });
  }

  async navigate(url: string): Promise<BrowserStatus> {
    return this.serialize(async () => {
      await this.callTool("browser_navigate", { url });
      const tabs = await this.readTabs();
      const aligned = await this.alignResearchTab(tabs);
      const current = aligned.find((tab) => tab.current) ?? aligned[0];
      return {
        available: true,
        url: (current?.url || url).slice(0, 4000),
        title: current?.title ? current.title.slice(0, 1000) : null,
        tab_count: aligned.length,
        screenshot_at: this.screenshotAt,
        error: null,
      } satisfies BrowserStatus;
    });
  }

  async screenshot(): Promise<Buffer> {
    return this.serialize(async () => {
      const tabs = await this.readTabs();
      await this.alignResearchTab(tabs);
      const result = await this.callTool("browser_take_screenshot", {
        type: "jpeg",
        scale: "css",
      });
      const image = resultImage(result);
      if (!image) throw new Error("Playwright did not return a screenshot");
      this.screenshotAt = new Date().toISOString();
      return image;
    });
  }

  async interact(input: BrowserInteractionInput): Promise<BrowserStatus> {
    return this.serialize(async () => {
      let code: string;
      if (input.action === "click") {
        code = `async (page) => page.mouse.click(${input.x}, ${input.y})`;
      } else if (input.action === "scroll") {
        code = `async (page) => {
          await page.mouse.move(${input.x}, ${input.y});
          await page.mouse.wheel(${input.delta_x}, ${input.delta_y});
        }`;
      } else if (input.action === "type") {
        code = `async (page) => page.keyboard.insertText(${JSON.stringify(input.text)})`;
      } else {
        code = `async (page) => page.keyboard.press(${JSON.stringify(input.key)})`;
      }

      await this.callTool(
        "browser_run_code_unsafe",
        BrowserRunCodeInputSchema.parse({ code }),
      );
      const tabs = await this.readTabs();
      const aligned = await this.alignResearchTab(tabs);
      const current = aligned.find((tab) => tab.current) ?? aligned[0];
      return {
        available: true,
        url: current?.url ? current.url.slice(0, 4000) : null,
        title: current?.title ? current.title.slice(0, 1000) : null,
        tab_count: aligned.length,
        screenshot_at: this.screenshotAt,
        error: null,
      } satisfies BrowserStatus;
    });
  }

  private async connect(): Promise<void> {
    if (this.client) return;
    if (this.connection) return this.connection;

    this.connection = (async () => {
      const client = new Client({
        name: "kalki-browser-bridge",
        version: "0.1.0",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(config.playwrightMcpUrl),
      );
      try {
        await client.connect(transport as Parameters<Client["connect"]>[0]);
        this.client = client;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      } finally {
        this.connection = null;
      }
    })();

    return this.connection;
  }

  private disconnect(): void {
    const client = this.client;
    this.client = null;
    if (client) void client.close().catch(() => undefined);
  }

  private async readTabs(): Promise<BrowserTab[]> {
    const result = await this.callTool("browser_tabs", { action: "list" });
    return parseTabs(resultText(result));
  }

  private async alignResearchTab(tabs: BrowserTab[]): Promise<BrowserTab[]> {
    const current = tabs.find((tab) => tab.current);
    const research =
      current?.url && current.url !== "about:blank"
        ? current
        : (tabs.find((tab) => tab.url && tab.url !== "about:blank") ?? current);
    if (research && current?.index !== research.index) {
      await this.callTool("browser_tabs", {
        action: "select",
        index: research.index,
      });
      return this.readTabs();
    }
    return tabs;
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    await this.connect();
    if (!this.client) throw new Error("Playwright client is not connected");
    const result = PlaywrightToolResultSchema.parse(
      await this.client.callTool({ name, arguments: args }),
    );
    if (result.isError) {
      throw new Error(resultText(result) || `Playwright tool '${name}' failed`);
    }
    return result;
  }
}
