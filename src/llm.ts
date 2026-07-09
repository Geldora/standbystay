import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { config, CORRIDOR } from "./config.js";
import { callTool, type McpTool, type McpToolResult } from "./mcp-client.js";

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a non-rev travel concierge for airline employees flying standby.

Non-rev travelers don't know which city they'll land in until they clear at the gate. Your job is to pre-research 3★ hotels in both candidate cities so the moment they land, a checkout link is ready in seconds.

══ FIXED CORRIDOR — never ask about these, never change them ══
• Candidate cities: Paris (CDG) or Barcelona (BCN)
• Night: check-in ${CORRIDOR.checkIn}, check-out ${CORRIDOR.checkOut} (Saturday night)
• Occupancy: 1 room, 2 adults
• Max budget: €150/night

══ RULE 1 — CONFIRM-BEFORE-SEARCH (mandatory, no exceptions) ══
On every new conversation — regardless of what the user types first — you MUST state the full corridor and wait for explicit confirmation before calling any tool. Example:
"I'll search 3★ hotels in both Paris and Barcelona for Saturday night, 25 July (2 adults, 1 night, up to €150/night). Ready to search?"
Do NOT search silently. Do NOT skip this step under any circumstance.

══ RULE 2 — SEARCH BOTH CITIES (after user confirms) ══
Call hotel_search TWICE — once for Paris (destinationId="437227"), once for Barcelona (destinationId="482477").
The system enforces all other parameters (dates, rooms, coordinates, budget filter) automatically.

After both searches, interpret the tool result for each city:
• "noBudgetResults": false → hotels found in budget. Briefly describe the top pick (name, price, stars).
• "noBudgetResults": true → no 3★ hotel within €150 in that city. Say so clearly, state the cheapestAvailablePrice,
  and ask: "Want me to search up to €200/night for [city]?"
  If yes: call hotel_search again for THAT city only — the system auto-applies the €200 limit.
  Do NOT invent any hotel. Do NOT offer hotels from the other city as alternatives.

══ RULE 3 — RESOLUTION ══
When the user reports which city they landed in, execute ALL steps below WITHOUT sending any text response until STEP 4. Do not pause, do not ask for confirmation, do not announce intermediate results. Use the hotelId and token already in SESSION STATE — do NOT call hotel_search again.

STEP 1 — Get rooms and rates (DO NOT respond to user here):
  Call hotel_get_rooms_and_rates with the top pick hotelId from SESSION STATE.
  Only pass: hotelId. Do NOT pass token, correlationId, checkIn, checkOut, or rooms.
  If it fails: retry once with the backup hotelId from SESSION STATE.

STEP 2 — Revalidate (DO NOT respond to user here):
  Call hotel_revalidate_rate with hotelId and recommendationId from the STEP 1 result.
  Only pass: hotelId, recommendationId. Do NOT pass token or correlationId.

STEP 3 — Get checkout link (DO NOT respond to user here):
  Call hotel_get_checkout_url with roomId and recommendationId from the STEP 1 result.
  Only pass: roomId, recommendationId. Do NOT pass token, correlationId, or any other field.

STEP 4 — Deliver the link (first and only response to user in this flow):
  Say: "Your checkout link for {hotelName} is ready below — tap it to complete your booking on RouteStack."
  NEVER include the raw checkout URL or a markdown link in your reply — the button below your message is the only place the link appears.
  NEVER mention price changes or rate differences.

If neither city cleared: respond with empathy. No booking needed.

══ STRICT RULES ══
• NEVER ask about flights, routes, departure times, layovers, or seat availability
• NEVER invent IDs — always use IDs from tool results or SESSION STATE
• NEVER call flight, car, hotel_search_destinations, or any non-hotel tools
• Only call hotel_search when instructed by Rule 2 or Rule 3 — never speculatively
• NEVER suggest the user go directly to a hotel, contact a hotel desk, or book through any channel other than the RouteStack checkout link — always attempt the full booking flow first
• NEVER offer "Option A / Option B" style alternatives during the resolution flow — execute all steps and deliver the link
• Keep responses brief — the user is at an airport gate, on a phone
• If asked anything unrelated, gently redirect to the hotel plan`;

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResult {
  response: string;
  messages: Message[];
}

export type OnToolCall = (name: string, args: Record<string, unknown>) => void;

export type Stage = "idle" | "searching" | "showing_options" | "resolved";

export interface HotelSummary {
  id: string;
  name: string;
  starRating: number;
  ourprice: number;
  publishedRate: number;
  distance: number;
  heroImage: string;
}

export interface DestinationState {
  topPick: HotelSummary | null;
  backup: HotelSummary | null;
  token: string;
  correlationId: string;
  noBudgetResults: boolean;
  cheapestAvailablePrice?: number;
  hotelChanged?: boolean;
  expiredHotelName?: string;
  failedHotelIds: string[];
}

export interface NonRevContext {
  paris: DestinationState | null;
  barcelona: DestinationState | null;
  resolved: null | "paris" | "barcelona" | "none";
  maxPrice: number;
  booking: {
    hotelId?: string;
    hotelName?: string;
    hotelImage?: string;
    hotelStarRating?: number;
    hotelRating?: number;
    hotelLatitude?: number;
    hotelLongitude?: number;
    destination?: string;
    token?: string;
    correlationId?: string;
    publishedRate?: number;
    rooms?: any[];
    selectedRoom?: {
      roomId?: string;
      recommendationId?: string;
      publishedRate?: number;
    };
    checkoutUrl?: string;
    address?: string;
    checkinTime?: string;
    checkoutTime?: string;
    guestRating?: number;
    reviewCount?: number;
    landmark?: string;
    confirmed?: boolean;
    confirmedAt?: number;
  };
}

export function makeContext(): NonRevContext {
  return { paris: null, barcelona: null, resolved: null, maxPrice: CORRIDOR.maxPricePerNight, booking: {} };
}

export function getStage(ctx: NonRevContext): Stage {
  if (ctx.resolved !== null) return "resolved";
  if (ctx.paris !== null && ctx.barcelona !== null) return "showing_options";
  if (ctx.paris !== null || ctx.barcelona !== null) return "searching";
  return "idle";
}

export function getHotelsPayload(ctx: NonRevContext) {
  if (!ctx.paris && !ctx.barcelona) return null;
  return {
    paris: ctx.paris?.topPick
      ? {
          ...ctx.paris.topPick,
          iata: CORRIDOR.paris.iata,
          city: CORRIDOR.paris.city,
          airportTransferMins: CORRIDOR.paris.airportTransferMins,
        }
      : null,
    barcelona: ctx.barcelona?.topPick
      ? {
          ...ctx.barcelona.topPick,
          iata: CORRIDOR.barcelona.iata,
          city: CORRIDOR.barcelona.city,
          airportTransferMins: CORRIDOR.barcelona.airportTransferMins,
        }
      : null,
  };
}

// Mocked "transaction successful" step — hotel_get_checkout_url returns only a checkout
// URL, no real confirmation payload exists, so this is built from search/details data
// already captured in context.booking rather than a real RouteStack booking response.
export function buildConfirmationSummary(ctx: NonRevContext) {
  const b = ctx.booking;
  const reference = b.correlationId ? `RS-${b.correlationId.slice(0, 8).toUpperCase()}` : "RS-UNKNOWN";

  const summary = {
    hotelName: b.hotelName ?? "your hotel",
    destination: b.destination ?? "",
    address: b.address ?? null,
    checkIn: CORRIDOR.checkIn,
    checkOut: CORRIDOR.checkOut,
    checkinTime: b.checkinTime ?? null,
    checkoutTime: b.checkoutTime ?? null,
    price: b.selectedRoom?.publishedRate ?? b.publishedRate ?? null,
    guestRating: b.guestRating ?? null,
    reviewCount: b.reviewCount ?? null,
    landmark: b.landmark ?? null,
    reference,
  };

  const lines = [`🎉 **Booking confirmed!**`, ``, `**${summary.hotelName}**, ${summary.destination}`];
  if (summary.address) lines.push(`📍 ${summary.address}`);
  lines.push(`📅 Check-in ${summary.checkIn}${summary.checkinTime ? ` from ${summary.checkinTime}` : ""} → Check-out ${summary.checkOut}${summary.checkoutTime ? ` by ${summary.checkoutTime}` : ""}`);
  lines.push(`👥 2 adults · 1 night`);
  if (summary.price) lines.push(`💶 €${summary.price}/night`);
  if (summary.guestRating) lines.push(`⭐ ${summary.guestRating}/5${summary.reviewCount ? ` (${summary.reviewCount} reviews)` : ""}`);
  if (summary.landmark) lines.push(`📌 ${summary.landmark}`);
  lines.push(`🔖 Reference: ${summary.reference}`);

  return { message: lines.join("\n"), summary };
}

// ---------------------------------------------------------------------------
// TOOL ALLOW-LIST — hotel flow only, no flights or cars
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = new Set([
  "hotel_search",
  "hotel_get_details",
  "hotel_get_rooms_and_rates",
  "hotel_revalidate_rate",
  "hotel_get_checkout_url",
]);

export function buildSessionContext(ctx: NonRevContext): string {
  const lines: string[] = ["══ SESSION STATE ══"];

  const destLines = (state: DestinationState | null, label: string) => {
    if (!state) {
      lines.push(`${label}: not yet searched`);
      return;
    }
    if (state.noBudgetResults) {
      const cheapest = state.cheapestAvailablePrice ? ` — cheapest available €${state.cheapestAvailablePrice}` : "";
      lines.push(`${label}: no hotels found within €${ctx.maxPrice}/night${cheapest}`);
      return;
    }
    if (state.topPick) {
      lines.push(`${label} top pick:  hotelId="${state.topPick.id}"  name="${state.topPick.name}"  price=€${state.topPick.ourprice}`);
    }
    if (state.backup) {
      lines.push(`${label} backup:    hotelId="${state.backup.id}"  name="${state.backup.name}"`);
    }
    if (state.hotelChanged && state.expiredHotelName) {
      lines.push(`${label} NOTE: original hotel "${state.expiredHotelName}" was unavailable at resolution`);
    }
  };

  destLines(ctx.paris, "Paris");
  destLines(ctx.barcelona, "Barcelona");

  if (ctx.maxPrice > 150) {
    lines.push(`Budget: increased to €${ctx.maxPrice}/night (user approved)`);
  }

  if (ctx.resolved) {
    lines.push(`Resolved: ${ctx.resolved}`);
  }

  return lines.join("\n");
}

export function filterTools(tools: McpTool[]): McpTool[] {
  return tools.filter((t) => ALLOWED_TOOLS.has(t.name));
}

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------

export async function chat(
  messages: Message[],
  tools: McpTool[],
  context: NonRevContext,
  onToolCall?: OnToolCall,
): Promise<ChatResult> {
  if (config.llm.provider === "anthropic") return chatAnthropic(messages, tools, context, onToolCall);
  if (config.llm.provider === "mistral") return chatMistral(messages, tools, context, onToolCall);
  return chatOpenAI(messages, tools, context, onToolCall);
}

// ---------------------------------------------------------------------------
// ARG BUILDER
// ---------------------------------------------------------------------------

function buildToolArgs(
  name: string,
  args: Record<string, unknown>,
  tool: McpTool,
  context: NonRevContext,
): Record<string, unknown> {
  const enriched = { ...args };
  const schema = isRecord(tool.inputSchema?.properties) ? tool.inputSchema.properties : {};

  if (name === "hotel_search") {
    const destId = enriched.destinationId as string;

    // Budget increase: if this destination was already searched and found nothing in budget,
    // this is the user-approved re-search at €200.
    if (destId === CORRIDOR.paris.destinationId && context.paris?.noBudgetResults) {
      context.maxPrice = 200;
    } else if (destId === CORRIDOR.barcelona.destinationId && context.barcelona?.noBudgetResults) {
      context.maxPrice = 200;
    }

    // Enforce corridor coordinates
    if (destId === CORRIDOR.paris.destinationId) {
      enriched.lat = CORRIDOR.paris.lat;
      enriched.long = CORRIDOR.paris.long;
    } else if (destId === CORRIDOR.barcelona.destinationId) {
      enriched.lat = CORRIDOR.barcelona.lat;
      enriched.long = CORRIDOR.barcelona.long;
    }
    enriched.checkIn = CORRIDOR.checkIn;
    enriched.checkOut = CORRIDOR.checkOut;
    enriched.rooms = CORRIDOR.rooms;
    enriched.page = 1;
    enriched.limit = 10;
    enriched.currency = CORRIDOR.currency;
  }

  if (name === "hotel_get_rooms_and_rates") {
    const hotelId = enriched.hotelId as string;
    if (hotelId) {
      for (const [dest, state] of [["paris", context.paris], ["barcelona", context.barcelona]] as const) {
        if (!state || !state.topPick) continue;
        const isTop = state.topPick.id === hotelId;
        const isBack = state.backup?.id === hotelId;
        if (isTop || isBack) {
          const hotel = isTop ? state.topPick : state.backup!;
          context.booking.hotelId = hotel.id;
          context.booking.hotelName = hotel.name;
          context.booking.hotelImage = hotel.heroImage;
          context.booking.hotelStarRating = hotel.starRating;
          context.booking.hotelRating = hotel.starRating;
          context.booking.publishedRate = hotel.publishedRate || hotel.ourprice || 0;
          context.booking.token = state.token;
          context.booking.correlationId = state.correlationId;
          context.booking.destination = dest === "paris" ? CORRIDOR.paris.city : CORRIDOR.barcelona.city;
          context.booking.hotelLatitude = dest === "paris" ? CORRIDOR.paris.lat : CORRIDOR.barcelona.lat;
          context.booking.hotelLongitude = dest === "paris" ? CORRIDOR.paris.long : CORRIDOR.barcelona.long;
          if (!context.resolved) context.resolved = dest;
          break;
        }
      }
    }
    enriched.checkIn = CORRIDOR.checkIn;
    enriched.checkOut = CORRIDOR.checkOut;
    // hotel_get_rooms_and_rates requires a children field that hotel_search does not
    enriched.rooms = CORRIDOR.rooms.map((r: any) => ({ ...r, children: 0 }));
  }

  // Inject booking context into downstream calls
  const b = context.booking;
  // Always force server-controlled values — never trust LLM-provided token/correlationId
  if ("token" in schema && b.token) enriched.token = b.token;
  if ("correlationId" in schema && b.correlationId) enriched.correlationId = b.correlationId;
  if ("hotelId" in schema && b.hotelId && !hasValue(enriched.hotelId)) enriched.hotelId = b.hotelId;
  if ("hotelName" in schema && b.hotelName && !hasValue(enriched.hotelName)) enriched.hotelName = b.hotelName;
  if ("hotelImage" in schema && b.hotelImage && !hasValue(enriched.hotelImage)) enriched.hotelImage = b.hotelImage;
  if ("hotelStarRating" in schema && b.hotelStarRating !== undefined && !hasValue(enriched.hotelStarRating)) enriched.hotelStarRating = b.hotelStarRating;
  if ("hotelRating" in schema && b.hotelRating !== undefined && !hasValue(enriched.hotelRating)) enriched.hotelRating = b.hotelRating;
  if ("hotelLatitude" in schema && b.hotelLatitude !== undefined && !hasValue(enriched.hotelLatitude)) enriched.hotelLatitude = b.hotelLatitude;
  if ("hotelLongitude" in schema && b.hotelLongitude !== undefined && !hasValue(enriched.hotelLongitude)) enriched.hotelLongitude = b.hotelLongitude;
  if ("destination" in schema && b.destination && !hasValue(enriched.destination)) enriched.destination = b.destination;
  if ("publishedRate" in schema && b.publishedRate != null && !hasValue(enriched.publishedRate)) enriched.publishedRate = b.publishedRate;
  if ("roomId" in schema && b.selectedRoom?.roomId && !hasValue(enriched.roomId)) enriched.roomId = b.selectedRoom.roomId;
  if ("recommendationId" in schema && b.selectedRoom?.recommendationId && !hasValue(enriched.recommendationId)) enriched.recommendationId = b.selectedRoom.recommendationId;
  if ("displayedPrice" in schema && b.selectedRoom?.publishedRate !== undefined && !hasValue(enriched.displayedPrice)) enriched.displayedPrice = b.selectedRoom.publishedRate;
  if ("checkIn" in schema && !hasValue(enriched.checkIn)) enriched.checkIn = CORRIDOR.checkIn;
  if ("checkOut" in schema && !hasValue(enriched.checkOut)) enriched.checkOut = CORRIDOR.checkOut;

  return enriched;
}

// ---------------------------------------------------------------------------
// CONTEXT UPDATE
// ---------------------------------------------------------------------------

// Captures the rich fields from get_hotel_details (address, guest rating, check-in/out
// times, a landmark line) that hotel_get_payment_url never returns, for the mock
// "Transaction Complete" summary — this call already happens on every booking (CUG
// requirement), its response was previously discarded.
function captureHotelDetails(json: any, context: NonRevContext) {
  const r = json?.result;
  if (!r) return;

  const addr = r.contact?.address;
  if (addr?.line1) {
    context.booking.address = [addr.line1, addr.city?.name, addr.postalCode, addr.country?.name]
      .filter(Boolean)
      .join(", ");
  }

  if (r.checkinInfo?.beginTime) context.booking.checkinTime = r.checkinInfo.beginTime;
  if (r.checkoutInfo?.time) context.booking.checkoutTime = r.checkoutInfo.time;

  const guest = r.eanRating?.ratings?.guest;
  if (guest?.overall) context.booking.guestRating = Number(guest.overall);
  if (guest?.count) context.booking.reviewCount = Number(guest.count);

  const headline = r.descriptions?.find((d: any) => d.type === "headline")?.text;
  if (headline) context.booking.landmark = headline;
}

function updateExecutionContext(toolName: string, args: Record<string, unknown>, result: any, context: NonRevContext) {
  if (!result) return;

  if (toolName === "hotel_search") {
    const destId = args.destinationId as string;
    const hotels: any[] = result?.result?.result ?? [];
    const token: string = result?.result?.token ?? "";
    const correlationId: string = result?.result?.correlationId ?? "";

    const prevState = destId === CORRIDOR.paris.destinationId ? context.paris
      : destId === CORRIDOR.barcelona.destinationId ? context.barcelona
      : null;

    const previousTopPickId = prevState?.topPick?.id ?? null;
    const previousTopPickName = prevState?.topPick?.name ?? null;
    // Resolution re-search: previous state exists and was NOT a budget-miss (topPick was found)
    const isResolutionResearch = prevState !== null && !prevState.noBudgetResults && prevState.topPick !== null;

    const pick = (h: any): HotelSummary => ({
      id: h.id,
      name: h.name,
      starRating: h.starRating,
      ourprice: h.ourprice,
      publishedRate: h.publishedRate,
      distance: h.distance,
      heroImage: h.heroImage ?? "",
    });

    const allPicks = hotels.map(pick);
    const inBudget = allPicks.filter((h) => h.ourprice <= context.maxPrice);

    let topPick: HotelSummary | null = null;
    let backup: HotelSummary | null = null;
    let noBudgetResults = false;
    let cheapestAvailablePrice: number | undefined;
    let hotelChanged = false;
    let expiredHotelName: string | undefined;

    if (isResolutionResearch && previousTopPickId) {
      // Try to find the exact same hotel by ID (most reliable)
      const sameHotel = allPicks.find((h) => h.id === previousTopPickId);
      if (sameHotel) {
        topPick = sameHotel;
        backup = inBudget.find((h) => h.id !== sameHotel.id) ?? allPicks.find((h) => h.id !== sameHotel.id) ?? null;
      } else {
        // Original hotel gone — use best available in budget, or any if none in budget
        topPick = inBudget[0] ?? allPicks[0] ?? null;
        backup = inBudget[1] ?? allPicks[1] ?? null;
        hotelChanged = true;
        expiredHotelName = previousTopPickName ?? undefined;
      }
    } else if (inBudget.length > 0) {
      topPick = inBudget[0];
      backup = inBudget[1] ?? null;
    } else {
      noBudgetResults = true;
      cheapestAvailablePrice =
        allPicks.length > 0 ? Math.min(...allPicks.map((h) => h.ourprice)) : undefined;
    }

    const state: DestinationState = {
      topPick,
      backup,
      token,
      correlationId,
      noBudgetResults,
      cheapestAvailablePrice,
      hotelChanged,
      expiredHotelName,
      failedHotelIds: prevState?.failedHotelIds ?? [],
    };

    if (destId === CORRIDOR.paris.destinationId) context.paris = state;
    else if (destId === CORRIDOR.barcelona.destinationId) context.barcelona = state;
  }

  if (toolName === "hotel_get_rooms_and_rates") {
    if (result?.code === 5148 || result?.success === false) {
      // CUG sandbox: offers never have live sessions. Inject placeholder room so
      // hotel_get_checkout_url (a portal deep-link builder) can still be called.
      const hotelId = args.hotelId as string ?? context.booking.hotelId ?? "unknown";
      const price = context.booking.publishedRate ?? 0;
      console.log(`[hotel_get_rooms_and_rates] 5148 — injecting placeholder room for hotel ${hotelId}`);
      context.booking.selectedRoom = {
        roomId: `room-${hotelId}`,
        recommendationId: `rec-${hotelId}`,
        publishedRate: price,
      };
      return;
    }

    const groups = result?.result?.groups;
    const allRooms: any[] = groups
      ? groups.flatMap((g: any) => g.rooms ?? [])
      : result?.result?.rooms ?? [];

    context.booking.rooms = allRooms.slice(0, 5);

    if (result?.result?.token) context.booking.token = result.result.token;
    if (result?.result?.correlationId) context.booking.correlationId = result.result.correlationId;

    if (allRooms.length > 0) {
      const first = allRooms[0];
      context.booking.selectedRoom = {
        roomId: first.id,
        recommendationId: first.recommendationId,
        publishedRate: first.publishedRate ?? first.ourprice,
      };
    }
  }

  if (toolName === "hotel_revalidate_rate") {
    // Non-fatal: if revalidate fails (e.g. CUG 5148), keep existing token and continue
    if (result?.result?.token) context.booking.token = result.result.token;
  }

  if (toolName === "hotel_get_checkout_url") {
    console.log("[hotel_get_checkout_url raw]", JSON.stringify(result));
    const r = result?.result ?? result;
    const url =
      r?.url ?? r?.checkoutUrl ?? r?.paymentUrl ?? r?.deeplink ??
      r?.portalUrl ?? r?.link ?? r?.href ?? r?.redirectUrl;
    if (url) {
      context.booking.checkoutUrl = url;
      console.log("[hotel_get_checkout_url] checkout URL:", url);
    } else {
      console.log("[hotel_get_checkout_url] no URL found in result keys:", Object.keys(r ?? {}));
    }
  }
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

function validateArgs(tool: McpTool, args: Record<string, unknown>) {
  const required = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((f): f is string => typeof f === "string")
    : [];
  for (const field of required) {
    if (!hasValue(args[field])) throw new Error(`Missing required field: ${field}`);
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function extractJson(result: McpToolResult): any {
  for (const item of result.content) {
    if (typeof item.text === "string") {
      try { return JSON.parse(item.text); } catch {}
    }
  }
  return null;
}

// Returns the chosen hotel for the LLM — after updateExecutionContext has run,
// so the context already reflects the price filter and hotel continuity check.
function buildSearchToolResult(json: any, args: Record<string, unknown>, context: NonRevContext): string {
  const destId = args.destinationId as string;
  const state =
    destId === CORRIDOR.paris.destinationId ? context.paris
    : destId === CORRIDOR.barcelona.destinationId ? context.barcelona
    : null;

  if (state) {
    const chosen = state.topPick;
    return JSON.stringify({
      searchResult: {
        hotel: chosen
          ? { id: chosen.id, name: chosen.name, starRating: chosen.starRating, ourprice: chosen.ourprice, distance: chosen.distance }
          : null,
        noBudgetResults: state.noBudgetResults,
        cheapestAvailablePrice: state.cheapestAvailablePrice ?? null,
        hotelChanged: state.hotelChanged ?? false,
        expiredHotelName: state.expiredHotelName ?? null,
      },
    });
  }

  // Fallback: slim the raw result if destination unrecognised
  if (!json?.result?.result?.length) return JSON.stringify(json);
  const top = json.result.result[0];
  return JSON.stringify({
    searchResult: {
      hotel: { id: top.id, name: top.name, starRating: top.starRating, ourprice: top.ourprice, distance: top.distance },
      noBudgetResults: false, cheapestAvailablePrice: null, hotelChanged: false, expiredHotelName: null,
    },
  });
}

function slimRoomsResult(json: any): any {
  if (!json?.result?.groups?.length) return json;
  return {
    ...json,
    result: {
      id: json.result.id,
      token: json.result.token,
      correlationId: json.result.correlationId,
      rooms: json.result.groups
        .flatMap((g: any) => g.rooms.map((r: any) => ({
          id: r.id, name: r.name, recommendationId: r.recommendationId,
          ourprice: r.ourprice, publishedRate: r.publishedRate, refundable: r.refundable,
        })))
        .slice(0, 5),
    },
  };
}

function extractText(result: McpToolResult, toolName: string, args: Record<string, unknown>, context: NonRevContext): string {
  if (result.isError) {
    console.log(`[${toolName} ERROR]`, JSON.stringify(result.content));
    return `Error: ${JSON.stringify(result.content)}`;
  }
  const json = extractJson(result);
  if (!json) return result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
  if (toolName === "hotel_search") return buildSearchToolResult(json, args, context);
  if (toolName === "hotel_get_rooms_and_rates") {
    // On 5148 (CUG sandbox), return a synthetic room so the LLM continues to hotel_get_checkout_url
    if (json?.code === 5148 || json?.success === false) {
      const b = context.booking;
      const price = b.selectedRoom?.publishedRate ?? b.publishedRate ?? 0;
      return JSON.stringify({
        result: {
          groups: [{
            rooms: [{
              id: b.selectedRoom?.roomId ?? "room-placeholder",
              name: "Standard Room",
              recommendationId: b.selectedRoom?.recommendationId ?? "rec-placeholder",
              ourprice: price,
              publishedRate: price,
              refundable: true,
            }],
          }],
        },
      });
    }
    return JSON.stringify(slimRoomsResult(json));
  }
  if (toolName === "hotel_revalidate_rate") {
    // On failure, return synthetic success so LLM proceeds to hotel_get_checkout_url
    if (json?.code === 5148 || json?.success === false || !json?.result) {
      return JSON.stringify({ result: { success: true, token: context.booking.token } });
    }
  }
  return JSON.stringify(json);
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mcpToolsToOpenAI(tools: McpTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// ---------------------------------------------------------------------------
// OPENAI-COMPATIBLE ENGINE (OpenAI + Mistral)
// ---------------------------------------------------------------------------

async function chatOpenAICompatible(
  client: OpenAI,
  model: string,
  messages: Message[],
  tools: McpTool[],
  context: NonRevContext,
  onToolCall?: OnToolCall,
): Promise<ChatResult> {
  const fullSystem = `${SYSTEM_PROMPT}\n\n${buildSessionContext(context)}`;
  const oaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystem },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const oaiTools = mcpToolsToOpenAI(tools);

  for (let i = 0; i < 10; i++) {
    const response = await client.chat.completions.create({ model, messages: oaiMessages, tools: oaiTools });
    const choice = response.choices[0];
    if (!choice) throw new Error("No response from LLM");

    const msg = choice.message;
    oaiMessages.push(msg);

    if (!msg.tool_calls?.length) {
      const text = msg.content ?? "";
      return { response: text, messages: [...messages, { role: "assistant", content: text }] };
    }

    for (const tc of msg.tool_calls) {
      const tool = tools.find((t) => t.name === tc.function.name);
      if (!tool) continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}

      const finalArgs = buildToolArgs(tool.name, args, tool, context);
      validateArgs(tool, finalArgs);
      onToolCall?.(tool.name, finalArgs);

      // CUG provider requires hotel_get_details before hotel_get_rooms_and_rates
      if (tool.name === "hotel_get_rooms_and_rates" && context.booking.hotelId) {
        try {
          const detailsResult = await callTool("hotel_get_details", { hotelId: context.booking.hotelId });
          captureHotelDetails(extractJson(detailsResult), context);
          console.log("[auto] hotel_get_details called before hotel_get_rooms_and_rates");
        } catch (_) {}
      }

      const result = await callTool(tool.name, finalArgs);
      const json = extractJson(result);
      updateExecutionContext(tool.name, finalArgs, json, context);

      oaiMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: extractText(result, tool.name, finalArgs, context),
      });
    }
  }

  return { response: "Max iterations reached", messages };
}

async function chatOpenAI(messages: Message[], tools: McpTool[], context: NonRevContext, onToolCall?: OnToolCall) {
  return chatOpenAICompatible(new OpenAI({ apiKey: config.llm.openai.apiKey }), config.llm.openai.model, messages, tools, context, onToolCall);
}

async function chatMistral(messages: Message[], tools: McpTool[], context: NonRevContext, onToolCall?: OnToolCall) {
  return chatOpenAICompatible(
    new OpenAI({ apiKey: config.llm.mistral.apiKey, baseURL: config.llm.mistral.baseUrl }),
    config.llm.mistral.model, messages, tools, context, onToolCall,
  );
}

// ---------------------------------------------------------------------------
// ANTHROPIC
// ---------------------------------------------------------------------------

async function chatAnthropic(
  messages: Message[],
  tools: McpTool[],
  context: NonRevContext,
  onToolCall?: OnToolCall,
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: config.llm.anthropic.apiKey });
  const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));

  const fullSystem = `${SYSTEM_PROMPT}\n\n${buildSessionContext(context)}`;

  for (let i = 0; i < 10; i++) {
    const response = await client.messages.create({
      model: config.llm.anthropic.model,
      max_tokens: 1024,
      system: fullSystem,
      messages: anthropicMessages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (!toolUses.length) {
      const text = response.content.map((b: any) => b.text ?? "").join("\n").trim();
      return { response: text, messages: [...messages, { role: "assistant", content: text }] };
    }

    anthropicMessages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUses) {
      const tool = tools.find((t) => t.name === block.name);
      if (!tool) continue;

      const finalArgs = buildToolArgs(block.name, (block.input ?? {}) as Record<string, unknown>, tool, context);
      validateArgs(tool, finalArgs);
      onToolCall?.(block.name, finalArgs);

      // CUG provider requires hotel_get_details before hotel_get_rooms_and_rates
      if (block.name === "hotel_get_rooms_and_rates" && context.booking.hotelId) {
        try {
          const detailsResult = await callTool("hotel_get_details", { hotelId: context.booking.hotelId });
          const detailsJson = extractJson(detailsResult);
          captureHotelDetails(detailsJson, context);
          console.log("[auto] hotel_get_details called before hotel_get_rooms_and_rates");
          console.log("[hotel_get_details RAW]", JSON.stringify(detailsJson));
        } catch (_) {}
      }

      const loggedTools = ["hotel_search", "hotel_get_rooms_and_rates", "hotel_revalidate_rate", "hotel_get_checkout_url"];
      if (loggedTools.includes(block.name)) {
        console.log(`[${block.name} ARGS]`, JSON.stringify(finalArgs));
      }

      const result = await callTool(block.name, finalArgs);
      const json = extractJson(result);

      if (loggedTools.includes(block.name)) {
        console.log(`[${block.name} RAW]`, JSON.stringify(json));
      }

      updateExecutionContext(block.name, finalArgs, json, context);

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: extractText(result, block.name, finalArgs, context),
      });
    }

    anthropicMessages.push({ role: "user", content: toolResults });
  }

  return { response: "Max iterations reached", messages };
}
