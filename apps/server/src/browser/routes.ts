import {
  ApiErrorResponseSchema,
  BrowserInteractionInputSchema,
  BrowserNavigateInputSchema,
  BrowserStatusResponseSchema,
} from "@kalki/contracts";
import { Hono } from "hono";
import { DomainError } from "../domain/errors.js";
import { PlaywrightBrowser } from "./playwrightClient.js";

const browser = new PlaywrightBrowser();

export const browserRoutes = new Hono();

void browser.keepAlive();

function unavailable(error: unknown) {
  console.error(error);
  return new DomainError(
    "Playwright browser is unavailable",
    "browser_unavailable",
    503,
    true,
  );
}

browserRoutes.get("/api/v1/browser/status", async (c) => {
  return c.json(
    BrowserStatusResponseSchema.parse({ data: await browser.status() }),
  );
});

browserRoutes.get("/api/v1/browser/screenshot", async (c) => {
  try {
    const image = await browser.screenshot();
    return new Response(image as unknown as BodyInit, {
      headers: {
        "cache-control": "no-store",
        "content-type": "image/jpeg",
      },
    });
  } catch (error) {
    throw unavailable(error);
  }
});

browserRoutes.post("/api/v1/browser/navigate", async (c) => {
  const input = BrowserNavigateInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Browser URL must use HTTP or HTTPS",
          path: ["url"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  try {
    return c.json(
      BrowserStatusResponseSchema.parse({
        data: await browser.navigate(input.data.url),
      }),
    );
  } catch (error) {
    throw unavailable(error);
  }
});

browserRoutes.post("/api/v1/browser/interact", async (c) => {
  const input = BrowserInteractionInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Browser interaction is invalid",
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  try {
    return c.json(
      BrowserStatusResponseSchema.parse({
        data: await browser.interact(input.data),
      }),
    );
  } catch (error) {
    throw unavailable(error);
  }
});
