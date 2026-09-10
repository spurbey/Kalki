import { describe, expect, it } from "vitest";
import { canonicalTaskContract, computeTaskHash } from "./taskContract.js";

describe("canonicalTaskContract", () => {
  const baseContract = `# Task: Test

## Objective
Collect structured records.

## Acceptance checks
Done.
`;

  it("returns normalized contract text when no living memory is present", () => {
    const canonical = canonicalTaskContract(baseContract);
    expect(canonical).toBe(baseContract.trim() + "\n");
  });

  it("strips living memory when separated by horizontal divider ---", () => {
    const withDivider = `${baseContract}\n---\n## Living Memory\n### Exploration Findings\n- Found item at URL\n`;
    expect(canonicalTaskContract(withDivider)).toBe(canonicalTaskContract(baseContract));
    expect(computeTaskHash(withDivider)).toBe(computeTaskHash(baseContract));
  });

  it("strips living memory starting directly with ## Exploration Findings", () => {
    const withFindings = `${baseContract}\n## Exploration Findings\n- Found item at URL\n`;
    expect(canonicalTaskContract(withFindings)).toBe(canonicalTaskContract(baseContract));
    expect(computeTaskHash(withFindings)).toBe(computeTaskHash(baseContract));
  });

  it("strips implementation details appended to task.md", () => {
    const withImpl = `${baseContract}\n## Implementation\n### Schema\n- schema.yaml\n`;
    expect(canonicalTaskContract(withImpl)).toBe(canonicalTaskContract(baseContract));
    expect(computeTaskHash(withImpl)).toBe(computeTaskHash(baseContract));
  });

  it("handles CRLF and BOM correctly", () => {
    const crlf = `\uFEFF${baseContract.replace(/\n/g, "\r\n")}\r\n---\r\n## Living Memory\r\n- info\r\n`;
    expect(canonicalTaskContract(crlf)).toBe(canonicalTaskContract(baseContract));
    expect(computeTaskHash(crlf)).toBe(computeTaskHash(baseContract));
  });
});
