import { resolve } from 'node:path';

const serverPort = Number(process.env.KALKI_SERVER_PORT ?? 8788);

if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
  throw new Error('KALKI_SERVER_PORT must be an integer between 1 and 65535');
}

export const config = {
  databasePath: resolve(process.env.KALKI_DATABASE_PATH ?? '.data/kalki.db'),
  serverPort,
} as const;
