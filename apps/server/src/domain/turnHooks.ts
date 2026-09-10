/**
 * Phase Transition Hooks for TrueForge agent coordination.
 * Intercepts turn boundaries (canonical review gate answers and state transitions)
 * to deliver concise, state-aware execution guidance and guardrails.
 */

export function getPhaseGuidanceForQuestion(gateKind: string): string {
  if (gateKind === "task_review") {
    return [
      "\n[Phase Guidance: Reconnaissance]",
      "- Active Phase: exploring",
      "- Goal: Navigate to 1 representative entity, observe target schema fields, and persist physical evidence using `python -m kalki_runtime.research_cli capture --url <url> --out research/captures/<name>.html`.",
      "- Living Memory: Read task.md and append findings under `## Exploration Findings` (target URL, data paths/selectors, confirmed schema fields, seed discovery strategy).",
      "- Next Action: Author `schemas/<table-slug>.yaml`, register with `python -m kalki_runtime.schema_cli register`, and call ask_user_question for schema review.",
      "- Guardrails: Stop browser exploration immediately once 1 representative sample is captured. Never browse multiple detail pages interactively. Do NOT search for or reverse-engineer client search APIs (e.g. Algolia or Elasticsearch). Do NOT author operators or pipelines in this turn.",
    ].join("\n");
  }

  if (gateKind === "schema_review") {
    return [
      "\n[Phase Guidance: Building & Testing]",
      "- Active Phase: building",
      "- Goal: Read task.md `## Exploration Findings` and your saved capture. Author operators/<table_slug>.py offline against the saved capture, and pipelines/pipeline.yaml.",
      "- Living Memory: Update task.md under `## Implementation` with operator files and seed list.",
      "- Next Action:",
      "  1. Navigate the shared browser tab to the reviewed source URL before running the pipeline.",
      "  2. Execute test run: `PYTHONPATH=\"$PWD/.kalki/deps:/opt/tf/mcp-client\" python -m kalki_runtime.pipeline_cli test --limit 15`.",
      "  3. Complete test run: `PYTHONPATH=\"$PWD/.kalki/deps:/opt/tf/mcp-client\" python -m kalki_runtime.pipeline_cli complete --run-id <id>`.",
      "- Guardrails: Offline-first extraction from saved capture; do NOT query external search APIs. Test rows must remain sandbox-only (table_counts: {}). Stop at awaiting_production_confirmation.",
    ].join("\n");
  }

  return "";
}

export function getPhaseGuidanceForStage(stage: string): string {
  switch (stage) {
    case "aligning":
      return "Clarify scope, author task.md contract, and register via task_cli register.";
    case "exploring":
      return "Observe 1 representative entity, capture sample with research_cli capture, append findings to task.md, and register schema.";
    case "building":
      return "Read task.md findings, author operator and pipeline offline from capture, and run pipeline_cli test.";
    case "testing":
      return "Complete test run via pipeline_cli complete (table_counts: {}). Do not request production approval.";
    default:
      return "Follow framework skill protocol.";
  }
}
