# StandByStay — A Travel Concierge for Standby (non-rev) travellers 

Built for the RouteStack Build Challenge (21-day hackathon) by Valentina Borovaya
LinkedIn: https://www.linkedin.com/in/valentinaborovaya/

## The problem

Airline employees can fly standby. The tickets are deeply discounted, but the seat availability is confirmed at the last minute, i.e. at the boarding gate. Sometimes standby travellers don't know which city they'll land in until they clear the destination at the gate. That makes booking a hotel in advance almost impossible. Existing booking tools assume you know your itinerary in advance; non-rev travellers fly leg by leg and have no guarantee they end up where they planned to be.

As an airline employee, I've been using standby tickets and found myself booking hotels at the boarding gates, or while in the aircraft waiting to take-off, or even when I landed.

This tool was created to solve the problem of standby travelers booking a first night accommodation in the destination .  

## What StandByStay does

StandByStay is a conversational concierge that
front-loads the research. Once traveller confirms their destination, they'll only need to 
confirm and pay.

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

I used Claude for planning, designing and coding the StandByStay.

## Architecture

- Node/TypeScript backend (Hono), single-page vanilla JS/HTML frontend
- Claude drives the conversation and decides
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

We researched the "book both, cancel if destination is not cleared" pattern.  however the free cancellation windows are often relative to the hotel check-in time. Non-rev travellers are looking for last minute availability for the same day as the planned hotel check-in. Booking a room in advance creates a lapsed-cancellation risk. 

## What's deliberately out of scope

- No flight search: standby inventory is not available publicly
- Mo multi-night stays, no more than two candidate
destinations, no freeform date/destination parsing: the user input is
hardcoded rather than generalized, and the chat input's free text is a UX
affordance, not a parser.
bot or Claude Connector, and why search-retain-display was chosen over a
hold-then-resolve pattern.
