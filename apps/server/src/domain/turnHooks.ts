/** Short, automatic instructions appended after a review gate is answered. */
export function getPhaseGuidanceForQuestion(
  gateKind: string,
  decision = "approve",
): string {
  if (decision !== "approve") {
    return "\n[Phase hook]\nStop this phase. Re-read get_workbook_context and follow its next_expected_action.";
  }
  if (gateKind === "task_review") {
    return [
      "\n[Next phase: explore]",
      "1. Call get_workbook_context, then read task.md.",
      "2. Read references/browser-mcp.md only.",
      "3. Inspect one representative page and save one bounded capture under research/.",
      "4. Record only confirmed URLs, fields, and extraction path in task.md; then register the schema.",
      "Do not build the operator or explore search/index endpoints yet.",
    ].join("\n");
  }
  if (gateKind === "schema_review") {
    return [
      "\n[Next phase: build and test]",
      "1. Call get_workbook_context and read task.md findings.",
      "2. Read references/operator-contracts.md and references/pipeline-format.md.",
      "3. Write the operator and pipeline from saved evidence; do not invent fields or URLs.",
      "4. Run lint, then one bounded test run and complete_run.",
      "Keep test rows in files; stop when the task reaches production review.",
    ].join("\n");
  }
  if (gateKind === "production_review") {
    return [
      "\n[Next phase: production]",
      "1. Call get_workbook_context and use the approved run id.",
      "2. Check authorization before reading the source.",
      "3. Process one batch at a time and publish only the returned records.",
      "4. Finalize after the runner reports ready_to_finalize.",
      "Do not change task, schema, or pipeline files during this run.",
    ].join("\n");
  }
  return "";
}

export function getPhaseGuidanceForStage(stage: string): string {
  switch (stage) {
    case "aligning":
      return "Author task.md from the user request, then run task_cli register.";
    case "exploring":
      return "Read task.md, inspect one representative page, save a bounded capture, record findings, and register schemas.";
    case "building":
      return "Read task.md findings, author the operator and pipeline from saved evidence, then lint and test.";
    case "testing":
      return "Complete the test run with table_counts {}. Do not request production approval yet.";
    case "awaiting_production_confirmation":
      return "Use the matching production run, ask for explicit approval, and wait.";
    case "production_running":
      return "Run the approved pipeline in batches, publish each batch, then finalize.";
    default:
      return "Call get_workbook_context and follow next_expected_action.";
  }
}
