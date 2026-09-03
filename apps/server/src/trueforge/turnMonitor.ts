import type { GateKind, TrueForgeTurnInput } from "@kalki/contracts";
import { DomainError } from "../domain/errors.js";
import type { WorkbookService } from "../domain/workbookService.js";
import { compactAgentEvent } from "../events/agentEvent.js";
import type { EventStore } from "../events/eventStore.js";
import type {
  PendingTrueForgeQuestion,
  TrueForgeClient,
} from "./sessionClient.js";

const sweepIntervalMs = 30_000;

const gateOptions: Partial<Record<GateKind, string[]>> = {
  task_review: ["Approve task", "Request changes", "Cancel task"],
  schema_review: ["Approve schemas", "Request changes", "Cancel task"],
  production_review: [
    "Approve full production run",
    "Request changes",
    "Cancel run",
  ],
};

function gateKindForTaskState(state: string): GateKind {
  if (state === "awaiting_task_confirmation") return "task_review";
  if (state === "awaiting_schema_review") return "schema_review";
  if (state === "awaiting_production_confirmation") return "production_review";
  return "clarification";
}

/**
 * Keeps the stored turn row and its gate question in step with TrueForge.
 *
 * The event subscription is best effort: it can be torn down by a network blip
 * or a long silent stretch inside a turn. Reconciliation therefore runs after
 * every stream attempt, and a periodic sweep picks up turns whose stream never
 * came back — including turns left running by a server restart.
 */
export class TurnMonitor {
  private readonly streaming = new Map<string, Promise<void>>();
  private readonly reconciling = new Map<string, Promise<void>>();
  private recoveringSubmissions = false;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly workbooks: WorkbookService,
    private readonly events: EventStore,
    private readonly trueForge: TrueForgeClient,
    private readonly intervalMs: number = sweepIntervalMs,
  ) {}

  start() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep(), this.intervalMs);
    this.sweepTimer.unref();
    void this.recoverSubmittingQuestions()
      .catch((error) =>
        console.error("Could not recover question submissions", error),
      )
      .finally(() => void this.sweep());
  }

  stop() {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Streams a turn's events, then reconciles it however the stream ended. The
   * returned promise covers both halves; callers that only want the work
   * started can drop it.
   */
  watch(workbookId: string, sessionId: string, turnId: string): Promise<void> {
    const active = this.streaming.get(turnId);
    if (active) return active;

    const attempt = this.stream(workbookId, sessionId, turnId).finally(() => {
      this.streaming.delete(turnId);
    });
    this.streaming.set(turnId, attempt);
    return attempt;
  }

  private async stream(workbookId: string, sessionId: string, turnId: string) {
    try {
      const stored = this.workbooks.getCurrentTrueForgeTurn(workbookId);
      const after = stored?.id === turnId ? stored.last_sequence_number : 0;
      await this.trueForge.subscribeToTurn(
        sessionId,
        turnId,
        after,
        async (event, sequenceNumber) => {
          this.events.appendTurnEvent(
            workbookId,
            turnId,
            sequenceNumber,
            `agent.${event.type}`,
            {
              turn_id: turnId,
              upstream_sequence: sequenceNumber,
              event: compactAgentEvent(event),
            },
          );
        },
      );
    } catch (error) {
      console.error(`TrueForge event stream failed for turn ${turnId}`, error);
    }

    try {
      await this.reconcileOnce(workbookId, sessionId, turnId);
    } catch (error) {
      console.error(`Could not reconcile turn ${turnId}`, error);
    }
  }

  /** Pulls upstream state for a workbook's current turn when one is live. */
  async refreshCurrent(workbookId: string) {
    const workbook = this.workbooks.getWorkbook(workbookId);
    if (!workbook.trueforge_session_id) return;
    const current = this.workbooks.getCurrentTrueForgeTurn(workbookId);
    if (
      !current ||
      (current.status !== "running" && current.required_actions.length === 0)
    )
      return;

    if (current.status === "running") {
      void this.watch(workbookId, workbook.trueforge_session_id, current.id);
    }
    await this.reconcileOnce(
      workbookId,
      workbook.trueforge_session_id,
      current.id,
    );
  }

  async recordPendingQuestion(workbookId: string, turn: TrueForgeTurnInput) {
    const sessionId =
      this.workbooks.getWorkbook(workbookId).trueforge_session_id;
    if (!sessionId) return null;

    const question: PendingTrueForgeQuestion | null =
      await this.trueForge.getPendingQuestion(sessionId, turn);
    if (!question) return null;

    const snapshot = this.workbooks.getSnapshot(workbookId);
    if (snapshot.tasks.length > 1) {
      throw new DomainError(
        "Cannot match the question to one task",
        "ambiguous_question_task",
        409,
      );
    }
    const task = snapshot.tasks[0] ?? null;
    const run =
      snapshot.runs.find(
        (candidate) => candidate.status === "awaiting_confirmation",
      ) ?? null;
    const gateKind = gateKindForTaskState(task?.state ?? "aligning");

    return this.workbooks.savePendingQuestion(workbookId, {
      taskId: task?.id ?? null,
      runId: run?.id ?? null,
      gateKind,
      questionTurnId: question.questionTurnId,
      questionEventId: question.questionEventId,
      toolCallId: question.toolCallId,
      threadId: question.threadId,
      questionText: question.question,
      options: gateOptions[gateKind] ?? question.options,
    });
  }

  private async recoverSubmittingQuestions() {
    if (this.recoveringSubmissions) return;
    this.recoveringSubmissions = true;
    try {
      for (const item of this.workbooks.listSubmittingQuestions()) {
        try {
          let pageToken: string | undefined;
          const seenPageTokens = new Set<string>();
          let answerTurn: TrueForgeTurnInput | undefined;
          do {
            if (pageToken) {
              if (seenPageTokens.has(pageToken)) break;
              seenPageTokens.add(pageToken);
            }
            const page = await this.trueForge.listTurns(
              item.sessionId,
              pageToken,
            );
            answerTurn = page.turns.find(
              (turn) => turn.previousTurnId === item.question.question_turn_id,
            );
            pageToken = answerTurn ? undefined : page.nextPageToken ?? undefined;
          } while (!answerTurn && pageToken);
          if (answerTurn && item.question.answer_text && item.question.decision) {
            this.workbooks.saveTrueForgeTurn(item.workbookId, answerTurn);
            this.workbooks.completeQuestion(
              item.workbookId,
              item.question.tool_call_id,
              {
                question_event_id: item.question.question_event_id,
                question_turn_id: item.question.question_turn_id,
                thread_id: item.question.thread_id,
                answer: item.question.answer_text,
                decision: item.question.decision,
                gate_kind: item.question.gate_kind,
                ...(item.question.run_id
                  ? { related_run_id: item.question.run_id }
                  : {}),
              },
              answerTurn.id,
            );
          } else if (!answerTurn) {
            this.workbooks.resetQuestionSubmission(
              item.workbookId,
              item.question.tool_call_id,
            );
          }
        } catch (error) {
          console.error(`Could not recover question ${item.question.id}`, error);
        }
      }
    } finally {
      this.recoveringSubmissions = false;
    }
  }

  private reconcileOnce(
    workbookId: string,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    const active = this.reconciling.get(turnId);
    if (active) return active;

    const attempt = this.reconcile(workbookId, sessionId, turnId).finally(
      () => {
        this.reconciling.delete(turnId);
      },
    );
    this.reconciling.set(turnId, attempt);
    return attempt;
  }

  private async reconcile(
    workbookId: string,
    sessionId: string,
    turnId: string,
  ) {
    const turn = await this.trueForge.getTurn(sessionId, turnId);
    this.workbooks.saveTrueForgeTurn(workbookId, turn);
    if (turn.status === "running" || turn.status === "done") {
      await this.recordPendingQuestion(workbookId, turn);
      return;
    }
    this.reportAbandonedTurn(workbookId, turnId, turn.status);
  }

  /**
   * A cancelled or errored turn leaves its gate question unanswerable. Retire it
   * so the workspace stops waiting on an answer TrueForge can no longer accept.
   */
  private reportAbandonedTurn(
    workbookId: string,
    turnId: string,
    status: string,
  ) {
    const retired = this.workbooks.invalidateQuestionsForTurn(
      workbookId,
      turnId,
    );
    this.events.append(workbookId, "agent.turn.abandoned", {
      turn_id: turnId,
      status,
      invalidated_question_ids: retired.map((question) => question.id),
    });
  }

  /** Reconciles every turn still marked running, resuming lost streams. */
  async sweep() {
    try {
      await this.recoverSubmittingQuestions();
    } catch (error) {
      console.error("Could not recover question submissions", error);
    }

    let live: ReturnType<WorkbookService["listRunningTrueForgeTurns"]>;
    try {
      live = this.workbooks.listRunningTrueForgeTurns();
    } catch (error) {
      console.error("Could not list running TrueForge turns", error);
      return;
    }

    for (const turn of live) {
      if (this.streaming.has(turn.turnId)) continue;
      try {
        await this.reconcileOnce(turn.workbookId, turn.sessionId, turn.turnId);
        const current = this.workbooks.getCurrentTrueForgeTurn(turn.workbookId);
        if (current?.id === turn.turnId && current.status === "running") {
          void this.watch(turn.workbookId, turn.sessionId, turn.turnId);
        }
      } catch (error) {
        console.error(`Could not recover turn ${turn.turnId}`, error);
      }
    }
  }
}
