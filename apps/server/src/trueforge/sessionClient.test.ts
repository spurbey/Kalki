import { afterEach, describe, expect, it, vi } from "vitest";
import { TrueForgeClient } from "./sessionClient.js";

const encoder = new TextEncoder();
const sessionId = "session_founders";
const turnId = "turn_founders_1";

/** A subscribe response whose body the test feeds one SSE frame at a time. */
class FakeStream {
  readonly ok = true;
  readonly status = 200;
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(signal: AbortSignal) {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    signal.addEventListener("abort", () =>
      this.controller.error(signal.reason),
    );
  }

  push(sequence: number, type: string) {
    this.controller.enqueue(
      encoder.encode(`id: ${sequence}\ndata: ${JSON.stringify({ type })}\n\n`),
    );
  }
}

function fakeTransport() {
  const requests: string[] = [];
  const open: FakeStream[] = [];
  const waiting: ((stream: FakeStream) => void)[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    requests.push(String(url));
    const stream = new FakeStream(init?.signal as AbortSignal);
    const waiter = waiting.shift();
    if (waiter) waiter(stream);
    else open.push(stream);
    return stream as unknown as Response;
  });

  return {
    requests,
    next: () =>
      new Promise<FakeStream>((resolve) => {
        const ready = open.shift();
        if (ready) resolve(ready);
        else waiting.push(resolve);
      }),
  };
}

function client() {
  return new TrueForgeClient({
    baseUrl: "http://trueforge.test",
    model: "claude-opus-5",
    attachFrameworkSkill: false,
    frameworkSkillName: "kalki-framework",
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("turn subscription", () => {
  it("stays open through a turn that runs far past a request timeout", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const seen: number[] = [];
    const subscription = client().subscribeToTurn(
      sessionId,
      turnId,
      0,
      async (_event, sequence) => {
        seen.push(sequence);
      },
    );
    const stream = await transport.next();

    for (const sequence of [1, 2, 3]) {
      await vi.advanceTimersByTimeAsync(90_000);
      stream.push(sequence, sequence === 3 ? "turn.done" : "model.message");
      await vi.advanceTimersByTimeAsync(0);
    }
    await subscription;

    expect(seen).toEqual([1, 2, 3]);
    expect(transport.requests).toHaveLength(1);
  });

  it("restarts a silent stream from the last sequence it delivered", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const seen: number[] = [];
    const subscription = client().subscribeToTurn(
      sessionId,
      turnId,
      0,
      async (_event, sequence) => {
        seen.push(sequence);
      },
    );

    const first = await transport.next();
    first.push(1, "model.message");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(500);

    const second = await transport.next();
    second.push(2, "turn.done");
    await vi.advanceTimersByTimeAsync(0);
    await subscription;

    expect(seen).toEqual([1, 2]);
    expect(transport.requests[0]).toContain("after_sequence_number=0");
    expect(transport.requests[1]).toContain("after_sequence_number=1");
  });

  it("gives up once repeated attempts deliver nothing", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const subscription = client().subscribeToTurn(
      sessionId,
      turnId,
      0,
      async () => {},
    );
    const failure = subscription.then(
      () => null,
      (error: Error) => error,
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await transport.next();
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(500 * 2 ** attempt);
    }

    expect((await failure)?.message).toMatch(/produced nothing/);
    expect(transport.requests).toHaveLength(3);
  });
});
