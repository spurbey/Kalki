import { describe, expect, it } from "vitest";
import { getPhaseGuidanceForQuestion, getPhaseGuidanceForStage } from "./turnHooks.js";

describe("turnHooks", () => {
  it("provides reconnaissance guidance for task_review", () => {
    const guidance = getPhaseGuidanceForQuestion("task_review");
    expect(guidance).toContain("[Phase Guidance: Reconnaissance]");
    expect(guidance).toContain("research_cli capture");
    expect(guidance).toContain("## Exploration Findings");
  });

  it("provides building guidance for schema_review", () => {
    const guidance = getPhaseGuidanceForQuestion("schema_review");
    expect(guidance).toContain("[Phase Guidance: Building & Testing]");
    expect(guidance).toContain("pipeline_cli test");
    expect(guidance).toContain("## Implementation");
  });

  it("returns empty string for unknown question kind", () => {
    expect(getPhaseGuidanceForQuestion("other")).toBe("");
  });

  it("returns stage guidance for known stages", () => {
    expect(getPhaseGuidanceForStage("exploring")).toContain("research_cli capture");
    expect(getPhaseGuidanceForStage("building")).toContain("pipeline_cli test");
  });
});
