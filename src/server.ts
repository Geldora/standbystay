import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import crypto from "node:crypto";
import chalk from "chalk";
import { config } from "./config.js";
import { connectMcp, listTools, disconnectMcp, type McpTool } from "./mcp-client.js";
import { chat, filterTools, makeContext, getStage, getHotelsPayload, buildConfirmationSummary, type Message, type NonRevContext } from "./llm.js";
import { getDb, upsertCase, resetCase } from "./db.js";

// ---------------------------------------------------------------------------
// SESSION STORE (in-memory; SQLite persists for cross-device resume)
// ---------------------------------------------------------------------------

interface Session {
  context: NonRevContext;
  history: Message[];
}

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { context: makeContext(), history: [] };
    sessions.set(sessionId, s);
    upsertCase(sessionId, {});
  }
  return s;
}

// ---------------------------------------------------------------------------
// APP
// ---------------------------------------------------------------------------

const app = new Hono();
let allTools: McpTool[] = [];
let hotelTools: McpTool[] = [];

app.get("/health", (c) =>
  c.json({ status: "ok", tools: hotelTools.length, provider: config.llm.provider }),
);



app.post("/api/chat", async (c) => {
  try {
    const body = await c.req.json<{ message: string; sessionId?: string }>();

    if (!body.message || typeof body.message !== "string") {
      return c.json({ error: "message is required" }, 400);
    }
    if (body.message.length > 4000) {
      return c.json({ error: "Message too long (max 4000 characters)" }, 400);
    }

    const sessionId = body.sessionId || crypto.randomUUID();
    const session = getOrCreateSession(sessionId);

    // A resolved case is a terminal state (checkout link delivered, or already
    // confirmed) — any further message (e.g. from a stale localStorage sessionId
    // surviving a page reload) starts a fresh case rather than resuming the old one.
    if (session.context.resolved !== null) {
      session.context = makeContext();
      session.history = [];
      resetCase(sessionId);
    }

    session.history.push({ role: "user", content: body.message });

    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const result = await chat(session.history, hotelTools, session.context, (name, args) => {
      toolCalls.push({ name, args });
      console.log(chalk.dim(`  [${sessionId.slice(0, 8)}] -> ${name}`));
    });

    session.history = result.messages;

    // Persist updated state
    const ctx = session.context;
    upsertCase(sessionId, {
      parisTop: ctx.paris?.topPick ?? undefined,
      parisBack: ctx.paris?.backup ?? undefined,
      bcnTop: ctx.barcelona?.topPick ?? undefined,
      bcnBack: ctx.barcelona?.backup ?? undefined,
      resolved: ctx.resolved ?? undefined,
    });

    const stage = getStage(ctx);
    const hotels = getHotelsPayload(ctx);
    const booking = ctx.booking.checkoutUrl
      ? {
          destination: ctx.resolved,
          hotelName: ctx.booking.hotelName,
          checkoutUrl: ctx.booking.checkoutUrl,
        }
      : null;

    return c.json({ response: result.response, sessionId, stage, hotels, booking, toolCalls });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Chat error: ${msg}`));
    return c.json({ error: "An error occurred processing your request." }, 500);
  }
});

// Demo-only: simulates the RouteStack payment-success callback that doesn't exist yet
// (hotel_get_payment_url returns just a checkout URL, no real transaction webhook).
app.post("/api/mock-confirm", async (c) => {
  try {
    const body = await c.req.json<{ sessionId?: string }>();
    const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
    if (!session) return c.json({ error: "Unknown session" }, 400);

    const ctx = session.context;
    if (!ctx.booking.checkoutUrl || !ctx.resolved) {
      return c.json({ error: "No resolved booking to confirm" }, 400);
    }

    const { message, summary } = buildConfirmationSummary(ctx);
    ctx.booking.confirmed = true;
    ctx.booking.confirmedAt = Date.now();
    session.history.push({ role: "assistant", content: message });

    upsertCase(body.sessionId!, { confirmed: true });

    return c.json({ message, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Mock-confirm error: ${msg}`));
    return c.json({ error: "An error occurred confirming the booking." }, 500);
  }
});

app.use("/*", serveStatic({ root: "./public" }));

// ---------------------------------------------------------------------------
// STARTUP
// ---------------------------------------------------------------------------

async function main() {
  // Ensure DB is initialised
  getDb();

  console.log(chalk.bold("\nStandByStay\n"));
  const model =
    config.llm.provider === "openai"
      ? config.llm.openai.model
      : config.llm.provider === "anthropic"
        ? config.llm.anthropic.model
        : config.llm.mistral.model;
  console.log(chalk.dim(`LLM: ${config.llm.provider} (${model})`));
  console.log(chalk.dim(`MCP: ${config.routestack.mcpUrl}\n`));

  console.log("Connecting to MCP...");
  await connectMcp();
  allTools = await listTools();
  hotelTools = filterTools(allTools);
  console.log(chalk.green(`Connected — ${hotelTools.length} hotel tool${hotelTools.length === 1 ? "" : "s"} available`));
  console.log(chalk.dim(`Tools: ${hotelTools.map((t) => t.name).join(", ")}`));
  console.log(chalk.dim(`All MCP tools: ${allTools.map((t) => t.name).join(", ")}\n`));

  serve({ fetch: app.fetch, port: config.port }, () => {
    console.log(chalk.bold(`Listening: http://localhost:${config.port}\n`));
  });
}

process.on("SIGINT", async () => {
  console.log(chalk.dim("\nShutting down..."));
  await disconnectMcp();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await disconnectMcp();
  process.exit(0);
});

main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});
