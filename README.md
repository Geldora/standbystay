# StandByStay — A Travel Concierge for Standby (non-rev) travellers 

Built for the RouteStack Build Challenge (21-day hackathon) by [Valentina Borovaya](https://www.linkedin.com/in/valentinaborovaya/).

StandByStay: https://standbystay.up.railway.app

## The problem

Airline employees have an amazing perk: the ability to buy standby tickets at steep discounts. The catch is that those seats are only confirmed at the last minute, sometimes at the boarding gate. This makes arranging accommodation difficult: every existing booking tool assumes travellers have a confirmed itinerary and prefer to plan in advance. As a standby traveller myself, I'd pre-search hotels, keep checkout links open in my browser, and scramble to finalise a booking while boarding the plane or just after landing. It adds anxiety to an already uncertain journey.

## What StandByStay does

StandByStay solves this problem by front-loading the research and deferring the reservation. It's a lightweight conversational hotel concierge for standby travellers. After confirming the parameters (destinations, price, number of nights etc), StandByStay searches all possible destinations simultaneously, holds a top and backup pick per city in reserve, and only triggers a live checkout call once the traveller confirms which destination they cleared. Nothing is booked until the boarding outcome is known. 

## Limitation of the demo

For this demo, the destinations are hardcoded: traveller is flying from Dublin, two
candidate destinations — Paris or Barcelona — for the night of
July 11, 2026, against a fixed preference set (3★, walking distance to the
city center, easy airport transfer, 2 adults, 1 night, €150 cap). The
agent states this scope up front and waits for explicit confirmation before
touching any RouteStack tool — nothing is searched silently.

Once confirmed, it searches RouteStack hotel inventory for **both**
destinations at once, keeping a top pick and a backup pick per city in
reserve, but only makes a live checkout call once the user reports which
destination actually cleared. Nothing is held or reserved before that. The "losing" destination's hotels are discarded.

Each hotel renders as a stylized boarding-pass-style card. Once destination is confirmed, the winning card becomes a "Complete your booking →"
button that opens RouteStack's real checkout portal. RouteStack doesn't expose the payment-confirmation webhook, so the demo simulates a 10-second
"processing" countdown after the click and then flips the card to a
confirmed state with the real address, dates, and RouteStack-issued
booking reference pulled from the API's own hotel-details response.

## AI usage disclosure

StandByStay was designed and built with Claude Code, with me directing product decisions and overseeing the outcomes.

## Architecture

- Node/TypeScript backend (Hono), single-page vanilla JS/HTML frontend
- Anthropic API drives the conversation and decides
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

## Context for product decisions

I researched the "book both, cancel if destination is not cleared" pattern.  however the free cancellation windows are often relative to the hotel check-in time. Non-rev travellers are looking for last minute availability for the same day as the planned hotel check-in. Booking a room in advance creates a lapsed-cancellation risk. 

## What's deliberately out of scope

- No flight search: standby inventory is not available publicly
- Mo multi-night stays, no more than two candidate
destinations, no freeform date/destination parsing: the user input is
hardcoded rather than generalized, and the chat input's free text is a UX
affordance, not a parser.
