import type { TrueForgeTurnInput } from "@kalki/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/database.js";
import { WorkbookService } from "../domain/workbookService.js";
import { EventStore } from "../events/eventStore.js";
import type { TrueForgeClient } from "./sessionClient.js";
import { TurnMonitor } from "./turnMonitor.js";

const sessionId = "session_founders";
const turnId = "turn_founders_1";

function upstreamTurn(
  overrides: Partial<TrueForgeTurnInput> = {},
): TrueForgeTurnInput {
  return {
    id: turnId,
    sessionId,
    previousTurnId: null,
    status: "running",
    requiredActions: [],
    createdAt: "2026-09-01T02:26:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function finished(status: TrueForgeTurnInput["status"]) {
  return upstreamTurn({ status, finishedAt: "2026-09-01T02:36:00.000Z" });
}

function harness(client: Partial<TrueForgeClient>) {
  const database = openDatabase(":memory:");
  const workbooks = new WorkbookService(database);
  const events = new EventStore(database);
  const workbook = workbooks.createWorkbook({ title: "Founders" });
  workbooks.connectTrueForgeSession(workbook.id, sessionId);
  const monitor = new TurnMonitor(
    workbooks,
    events,
    client as unknown as TrueForgeClient,
  );
  return { workbookId: workbook.id, workbooks, events, monitor };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("turn monitoring", () => {
  it("stores the turn's terminal state after the event stream dies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      subscribeToTurn: vi.fn(async () => {
        throw new Error("socket hung up");
      }),
      getTurn: vi.fn(async () => finished("done")),
      getPendingQuestion: vi.fn(async () => null),
    };
    const { workbookId, workbooks, monitor } = harness(client);
    workbooks.saveTrueForgeTurn(workbookId, upstreamTurn());

    await monitor.watch(workbookId, sessionId, turnId);

    expect(client.getTurn).toHaveBeenCalledWith(sessionId, turnId);
    expect(workbooks.getCurrentTrueForgeTurn(workbookId)?.status).toBe("done");
  });

  it("records the gate question a dropped stream never delivered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      subscribeToTurn: vi.fn(async () => {
        throw new Error("socket hung up");
      }),
      getTurn: vi.fn(async () => finished("done")),
      getPendingQuestion: vi.fn(async () => ({
        questionEventId: "event_ask",
        questionTurnId: turnId,
        threadId: "thread_1",
        toolCallId: "call_ask",
        question: "Approve the founders schema?",
        options: ["Yes", "No"],
      })),
    };
    const { workbookId, workbooks, monitor } = harness(client);
    workbooks.saveTrueForgeTurn(workbookId, upstreamTurn());

    await monitor.watch(workbookId, sessionId, turnId);

    const pending = workbooks.getPendingQuestion(workbookId);
    expect(pending?.tool_call_id).toBe("call_ask");
    expect(pending?.gate_kind).toBe("clarification");
  });

  it("retires the gate question of a cancelled turn", async () => {
    const client = {
      subscribeToTurn: vi.fn(async () => {}),
      getTurn: vi.fn(async () => finished("cancelled")),
      getPendingQuestion: vi.fn(async () => null),
    };
    const { workbookId, workbooks, events, monitor } = harness(client);
    workbooks.saveTrueForgeTurn(workbookId, upstreamTurn());
    const question = workbooks.savePendingQuestion(workbookId, {
      taskId: null,
      gateKind: "schema_review",
      questionTurnId: turnId,
      questionEventId: "event_ask",
      toolCallId: "call_ask",
      threadId: "thread_1",
      questionText: "Approve the founders schema?",
      options: ["Approve schemas", "Request changes"],
    });

    await monitor.watch(workbookId, sessionId, turnId);

    expect(workbooks.getPendingQuestion(workbookId)).toBeNull();
    const abandoned = events
      .listAfter(workbookId, 0)
      .find((event) => event.type === "agent.turn.abandoned");
    expect(abandoned?.payload).toMatchObject({
      turn_id: turnId,
      status: "cancelled",
      invalidated_question_ids: [question.id],
    });
  });

  it("recovers a running turn whose stream was never established", async () => {
    const client = {
      subscribeToTurn: vi.fn(async () => {}),
      getTurn: vi.fn(async () => finished("error")),
      getPendingQuestion: vi.fn(async () => null),
    };
    const { workbookId, workbooks, monitor } = harness(client);
    workbooks.saveTrueForgeTurn(workbookId, upstreamTurn());

    await monitor.sweep();

    expect(client.getTurn).toHaveBeenCalledWith(sessionId, turnId);
    expect(workbooks.getCurrentTrueForgeTurn(workbookId)?.status).toBe("error");
    expect(client.subscribeToTurn).not.toHaveBeenCalled();
  });

  it("logs streamed events against the turn cursor", async () => {
    const client = {
      subscribeToTurn: vi.fn(
        async (
          _sessionId: string,
          _turnId: string,
          after: number,
          onEvent: (event: { type: string }, sequence: number) => Promise<void>,
        ) => {
          expect(after).toBe(0);
          await onEvent({ type: "model.message" }, 1);
          await onEvent({ type: "turn.done" }, 2);
        },
      ),
      getTurn: vi.fn(async () => finished("done")),
      getPendingQuestion: vi.fn(async () => null),
    };
    const { workbookId, workbooks, events, monitor } = harness(client);
    workbooks.saveTrueForgeTurn(workbookId, upstreamTurn());

    await monitor.watch(workbookId, sessionId, turnId);

    expect(
      events.listAfter(workbookId, 0).map((event) => event.type),
    ).toContain("agent.turn.done");
    expect(
      workbooks.getCurrentTrueForgeTurn(workbookId)?.last_sequence_number,
    ).toBe(2);
  });
});
