import "dotenv/config";

export type LlmProvider = "openai" | "anthropic" | "mistral";

export const CORRIDOR = {
  paris: {
    destinationId: "437227",
    lat: 48.853564,
    long: 2.348095,
    iata: "CDG",
    city: "Paris",
    airportTransferMins: 35,
  },
  barcelona: {
    destinationId: "482477",
    lat: 41.387,
    long: 2.1686,
    iata: "BCN",
    city: "Barcelona",
    airportTransferMins: 35,
  },
  checkIn: "2026-07-11",
  checkOut: "2026-07-12",
  rooms: [{ adults: 2 }],
  currency: "EUR",
  maxPricePerNight: 150,
} as const;

export const config = {
  routestack: {
    apiKey: process.env.ROUTESTACK_API_KEY ?? "",
    apiSecret: process.env.ROUTESTACK_API_SECRET ?? "",
    mcpUrl: process.env.ROUTESTACK_MCP_URL ?? "https://mcp.routestack.ai/sse",
  },
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as LlmProvider,
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    },
    mistral: {
      apiKey: process.env.MISTRAL_API_KEY ?? "",
      model: process.env.MISTRAL_MODEL ?? "mistral-large-latest",
      baseUrl: process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai/v1",
    },
  },
  db: {
    path: process.env.DB_PATH ?? "nonrev.db",
  },
  port: Number(process.env.PORT ?? 3000),
} as const;

if (!config.routestack.apiKey) {
  console.error("Error: ROUTESTACK_API_KEY is required.");
  process.exit(1);
}

const { provider } = config.llm;
if (provider === "openai" && !config.llm.openai.apiKey) {
  console.error("Error: OPENAI_API_KEY is required when LLM_PROVIDER=openai.");
  process.exit(1);
}
if (provider === "anthropic" && !config.llm.anthropic.apiKey) {
  console.error("Error: ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic.");
  process.exit(1);
}
if (provider === "mistral" && !config.llm.mistral.apiKey) {
  console.error("Error: MISTRAL_API_KEY is required when LLM_PROVIDER=mistral.");
  process.exit(1);
}
