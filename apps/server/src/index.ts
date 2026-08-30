import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';

const app = new Hono();

app.get('/healthz', c => c.json({ ok: true }));

serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.serverPort,
  },
  info => console.log(`Kalki API listening on http://${info.address}:${info.port}`),
);
