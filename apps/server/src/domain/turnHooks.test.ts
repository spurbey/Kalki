import { describe, expect, it } from "vitest";
import { getPhaseGuidanceForQuestion, getPhaseGuidanceForStage } from "./turnHooks.js";

describe("turnHooks", () => {
  it("provides reconnaissance guidance for task_review", () => {
    const guidance = getPhaseGuidanceForQuestion("task_review");
    expect(guidance).toContain("[Next phase: explore]");
    expect(guidance).toContain("one representative page");
    expect(guidance).toContain("task.md");
  });

  it("provides building guidance for schema_review", () => {
    const guidance = getPhaseGuidanceForQuestion("schema_review");
    expect(guidance).toContain("[Next phase: build and test]");
    expect(guidance).toContain("saved evidence");
    expect(guidance).toContain("complete_run");
  });

  it("returns empty string for unknown question kind", () => {
    expect(getPhaseGuidanceForQuestion("other")).toBe("");
  });

  it("returns stage guidance for known stages", () => {
    expect(getPhaseGuidanceForStage("exploring")).toContain("bounded capture");
    expect(getPhaseGuidanceForStage("building")).toContain("lint and test");
  });
});
