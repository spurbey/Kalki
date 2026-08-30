import { resolve } from "node:path";

const serverPort = Number(process.env.KALKI_SERVER_PORT ?? 8788);
const mcpPort = Number(process.env.KALKI_MCP_PORT ?? 8792);
const repositoryRoot = resolve(import.meta.dirname, "../../..");

for (const [name, port] of [
  ["KALKI_SERVER_PORT", serverPort],
  ["KALKI_MCP_PORT", mcpPort],
] as const) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}

export const config = {
  databasePath: resolve(
    repositoryRoot,
    process.env.KALKI_DATABASE_PATH ?? ".data/kalki.db",
  ),
  serverPort,
  mcpPort,
  mcpToken: process.env.KALKI_MCP_TOKEN?.trim() ?? "",
  trueForgeBaseUrl: (
    process.env.TRUEFORGE_BASE_URL ?? "http://127.0.0.1:8790"
  ).replace(/\/+$/, ""),
  agentModel: process.env.KALKI_AGENT_MODEL?.trim() ?? "",
  attachFrameworkSkill: process.env.KALKI_ATTACH_SKILL === "true",
  frameworkSkillName:
    process.env.KALKI_FRAMEWORK_SKILL_NAME?.trim() || "kalki-framework",
} as const;
