import { resolve } from "node:path";

const serverPort = Number(process.env.KALKI_SERVER_PORT ?? 8788);
const repositoryRoot = resolve(import.meta.dirname, "../../..");

if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
  throw new Error("KALKI_SERVER_PORT must be an integer between 1 and 65535");
}

export const config = {
  databasePath: resolve(
    repositoryRoot,
    process.env.KALKI_DATABASE_PATH ?? ".data/kalki.db",
  ),
  serverPort,
  trueForgeBaseUrl: (
    process.env.TRUEFORGE_BASE_URL ?? "http://127.0.0.1:8790"
  ).replace(/\/+$/, ""),
  agentModel: process.env.KALKI_AGENT_MODEL?.trim() ?? "",
  attachFrameworkSkill: process.env.KALKI_ATTACH_SKILL === "true",
  frameworkSkillName:
    process.env.KALKI_FRAMEWORK_SKILL_NAME?.trim() || "kalki-framework",
} as const;
