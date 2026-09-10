import { createHash } from "node:crypto";

/**
 * Extracts the canonical task contract portion of task.md for deterministic hashing.
 * Living memory sections (e.g. `---`, `## Living Memory`, `## Exploration Findings`,
 * `## Implementation`, `## Progress`) are excluded from the contract hash so the agent
 * can freely append and update findings across turns without invalidating approvals.
 */
export function canonicalTaskContract(markdown: string): string {
  const normalized = markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");

  const markers = [
    "\n---\n",
    "\n## Living Memory",
    "\n## Exploration Findings",
    "\n## Implementation",
    "\n## Progress",
  ];

  let earliestIdx = -1;
  for (const marker of markers) {
    const idx = normalized.indexOf(marker);
    if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx;
    }
  }

  const contract = earliestIdx !== -1 ? normalized.slice(0, earliestIdx) : normalized;
  return contract.trim() + "\n";
}

export function computeTaskHash(markdown: string): string {
  return createHash("sha256")
    .update(canonicalTaskContract(markdown), "utf8")
    .digest("hex");
}
