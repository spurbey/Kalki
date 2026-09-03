import type { WorkbookEvent, WorkbookSnapshot } from "@kalki/contracts";
import { describe, expect, it } from "vitest";
import { evaluateWorkbook } from "./agentEvaluator.js";

const event = (seq: number, type: string, payload: Record<string, unknown>) =>
  ({
    seq,
    workbook_id: "wb_eval",
    type,
    payload,
    created_at: "2026-09-03T00:00:00.000Z",
  }) as WorkbookEvent;

describe("agent evaluator", () => {
  it("reports repeated reads and failed tool responses", () => {
    const events = [
      event(1, "agent.turn.created", {
        turn_id: "turn_1",
        event: { type: "turn.created", turn_id: "turn_1" },
      }),
      event(2, "agent.model.message.delta", {
        turn_id: "turn_1",
        event: {
          type: "model.message.delta",
          tool_calls: [
            {
              function: {
                name: "exec",
                arguments: JSON.stringify({ command: "cat task.md" }),
              },
            },
          ],
        },
      }),
      event(3, "agent.model.message.delta", {
        turn_id: "turn_1",
        event: {
          type: "model.message.delta",
          tool_calls: [
            {
              function: {
                name: "exec",
                arguments: JSON.stringify({ command: "cat task.md" }),
              },
            },
          ],
        },
      }),
      event(4, "agent.tool.response", {
        event: {
          type: "tool.response",
          content: JSON.stringify({ success: true, response: { exitCode: 1 } }),
        },
      }),
    ];
    const report = evaluateWorkbook(events, {
      workbook: { id: "wb_eval" },
      tasks: [{ state: "exploring" }],
    } as unknown as WorkbookSnapshot);

    expect(report.tool_calls).toMatchObject({
      total: 2,
      unique_signatures: 1,
      failed_responses: 1,
    });
    expect(report.tool_calls.action_counts).toEqual([
      { action: "exec:cat", count: 2 },
    ]);
    expect(report.repetition.consecutive[0]).toMatchObject({
      action: "exec:cat",
      count: 2,
    });
    expect(report.repetition.repeated_reads).toHaveLength(1);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "repetition",
      "tool_failure",
      "incomplete",
    ]);
    expect(report.findings[1]?.evidence[0]?.seq).toBe(4);
  });

  it("uses canonical tool names and the latest task state", () => {
    const events = [
      event(1, "agent.turn.created", {
        turn_id: "turn_1",
        event: { type: "turn.created", turn_id: "turn_1" },
      }),
      event(2, "agent.model.message.delta", {
        turn_id: "turn_1",
        event: {
          type: "model.message.delta",
          tool_calls: [
            {
              tool_info: { name: "browser_snapshot" },
              input: {},
            },
            {
              tool_info: { name: "x".repeat(500) },
              input: {},
            },
          ],
        },
      }),
      event(3, "agent.tool.response", {
        turn_id: "turn_1",
        event: { type: "tool.response", is_error: true, content: [] },
      }),
      event(4, "agent.turn.done", {
        turn_id: "turn_1",
        event: { type: "turn.done" },
      }),
    ];
    const report = evaluateWorkbook(events, {
      workbook: { id: "wb_eval" },
      tasks: [
        { id: "task_old", state: "completed" },
        { id: "task_new", state: "exploring" },
      ],
      pending_question: null,
    } as unknown as WorkbookSnapshot);

    expect(report.task_id).toBe("task_new");
    expect(report.workflow).toMatchObject({
      task_state: "exploring",
      terminal_status: "done",
    });
    expect(report.tool_calls.failed_responses).toBe(1);
    expect(report.tool_calls.action_counts[0]).toMatchObject({
      action: "browser_snapshot",
      count: 1,
    });
    expect(report.tool_calls.action_counts[1]?.action).toHaveLength(200);
  });
});
