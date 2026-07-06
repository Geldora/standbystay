# StandByStay — Non-Rev Travel Concierge

Built for the RouteStack Build Challenge (21-day hackathon).

## The problem

Airline employees flying non-rev (standby, last-minute, deeply discounted —
never bookable through a commercial engine) don't know which city they'll
land in until they clear at the gate. That makes booking a hotel in advance
impossible, but they still want a ready lodging plan the moment they know
where they've ended up. Existing booking tools assume you know your
itinerary in advance; non-rev travelers fly leg by leg with no fixed one.

## What it does

StandByStay is a conversational concierge, not a booking engine, that
front-loads the research so the only thing left to do at the gate is
confirm and pay.

For this V1 demo, the corridor is hardcoded: home base Dublin, two
candidate destinations — Paris or Barcelona — for the night of
July 11, 2026, against a fixed preference set (3★, walking distance to the
city center, easy airport transfer, 2 adults, 1 night, €150 cap). The
agent states this scope up front and waits for explicit confirmation before
touching any RouteStack tool — nothing is searched silently.

Once confirmed, it searches RouteStack hotel inventory for **both**
destinations at once, keeping a top pick and a backup pick per city in
reserve, but only makes a live checkout call once the user reports which
destination actually cleared. Nothing is held or reserved before that —
non-rev free-cancellation windows are pegged to check-in time, not booking
time, so holding a room early just creates a lapsed-cancellation risk for
no benefit. The losing destination's picks are simply discarded.

Each hotel renders as a boarding-pass-style card: an amber "stub" (airport
code, city, star rating) torn via a dashed perforation from the hotel
details below it — walk time to center, airport transfer time, price per
night. On resolution, the winning card becomes a "Complete your booking →"
button that opens RouteStack's real checkout portal; since RouteStack
exposes no payment-confirmation webhook, the demo simulates a 10-second
"processing" countdown after the click and then flips the card to a
confirmed state with the real address, dates, and RouteStack-issued
booking reference pulled from the API's own hotel-details response — no
fabricated data.

## Architecture

- Node/TypeScript backend (Hono), single-page vanilla JS/HTML frontend
- Claude (or OpenAI/Mistral, pluggable) drives the conversation and decides
  when to call RouteStack MCP tools; the confirm-before-search gate and
  fixed preference set are enforced in the system prompt, not inferred
- RouteStack MCP handles hotel search and checkout only — zero flight
  logic anywhere in this app; resolution is 100% user-reported, never polled
- Booking flow: `search_hotels` → `get_hotel_details` → `get_rooms_and_rates`
  → `revalidate` → `hotel_get_payment_url`, with the session's token and
  correlation ID injected server-side at every step so the LLM is never
  trusted to carry them through
- SQLite persists each case (destinations, retained picks, resolution
  status) so it can be resumed from a signed link

## What's deliberately out of scope for V1

No flight search, no multi-night stays, no more than two candidate
destinations, no freeform date/destination parsing — the corridor is
hardcoded rather than generalized, and the chat input's free text is a UX
affordance, not a parser. See `CLAUDE.md` in the repo root for the full
decision log, including why a standalone site was chosen over a Telegram
bot or Claude Connector, and why search-retain-display was chosen over a
hold-then-resolve pattern.
