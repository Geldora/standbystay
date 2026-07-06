# CLAUDE.md — StandByStay (Non-Rev Travel Concierge)

## What this is

A conversational AI concierge for airline employees traveling non-rev (standby,
last-minute, deeply discounted — not available through commercial booking engines).
Built for the RouteStack Build Challenge (21-day hackathon).

**The problem:** non-rev travelers don't know if they have a seat until the gate, or
boarding. That makes booking a hotel in advance impossible — but they still want a
ready lodging plan the moment they know where they've landed.

**What this is not:** a flight booking tool. Non-rev flights aren't bookable through
RouteStack or any commercial engine — zero flight logic exists in this app.

## Platform & stack

- Standalone website (chosen over a Telegram bot and a Claude Connector — see
  Decision Log below for why)
- `chat-agent` starter (or scaffolded from scratch if the official starter repo
  can't be located — confirm which before building further)
- Claude via the starter's Anthropic integration, as the conversational layer
- RouteStack MCP — **hotel search and checkout only**, no flight tooling
- SQLite for case persistence
- Resend for case-retrieval email (JWT link) — first feature to cut if time is short

## Demo corridor (hardcoded for V1 — do not generalize)

- Home base: Dublin
- Candidate destinations: Paris **or** Barcelona (exactly 2, both shown every time)
- Date window: Friday 10 July – Saturday 11 July
- Stay: 1 night in the destination only, no Dublin-side hotel
- Working assumption for the demo: Friday night (10 July) — adjustable, but pick
  one specific night rather than building date-range logic
- price less than 150 euro

**Sector-by-sector note:** non-rev travelers fly leg by leg with no fixed itinerary.
The agent should never ask about or track flight numbers, routes, or departure
timing. The only resolution input it ever needs is: which destination did the user
land in (or did neither clear).

## Hardcoded preference filter

Applied to every search, never asked about conversationally:
- 3★ comfort
- Walking distance to the touristic city center
- Easy transport connection to the airport
- 2 adults
- 1 night
- 150 euro budget

These are fixed defaults for V1, not inferred from user input — see "freeform input"
under Out of Scope.

## Core flow

### 1. Confirm-before-search gate
The agent states its assumed scope (both destinations, the date, the fixed
preference set) and waits for explicit user confirmation before calling any
RouteStack search tool. This is a hardcoded system-prompt rule — **never silent**,
regardless of how confident the agent is about the assumption. No clarifying
question is needed first, since preferences are fixed rather than inferred — the
agent just states and waits.

### 2. Search → retain → display (Pattern 2 — no pre-booking hold)
- Search RouteStack hotels for **both** destinations against the fixed filter
- Per destination, retain a top pick **and** a backup pick (in case the top pick's
  booking call fails later — sold out, rate changed)
- Display only the top pick per destination (2 options shown total)
- **No reservation is made at this stage.** Nothing is held, nothing has a
  cancellation deadline to track.

### 3. Resolution — driven entirely by what the user reports in chat
When the user reports which destination they landed in (or that neither cleared):
- Make **one live booking call** for that destination's retained top pick
- If that call fails, retry with the backup pick
- Discard the other destination's retained options
- No automated polling, ever. Resolution only happens off what's typed in chat.

## UI design direction

Established via mockup, not open for restyling without discussion:
- **Signature element:** each hotel option renders as a boarding-pass-style card —
  an amber "stub" (airport code, city, star rating, monospace) torn from the hotel
  detail body below it via a dashed perforation line with punched-hole notches.
- **Palette:** ink `#14181F` (text), paper `#FFFFFF` (card surface), canvas
  `#EEF0F4` (page background), amber `#E2A33D` (stub/accent), teal `#1F7A6C`
  (confirmed/booked state), slate `#7B8494` (secondary text/borders).
- **Type:** Space Grotesk for hotel names and headings, IBM Plex Mono for codes/
  prices/data, used sparingly and only for that data role.
- **Mobile-first is the actual use case**, not generic advice — the resolution
  moment happens at a gate, on a phone. Design and test narrow-viewport first.
- Each card shows: airport code + city + star rating (stub), hotel name, walk-to-
  center, airport transfer time, price/night, a small de-emphasized free-
  cancellation note, and a confirm action. "Free cancellation" matters less under
  Pattern 2 than it would under a hold-based pattern — keep it small, don't feature it.
- Resolution state: winning card becomes a compact "Checkout link ready" or "Complete your booking"; User taps it to complete payment on the RouteStack portal. The losing card becomes a faded "released, not needed" strip.

## In scope for V1

- Conversational interface with free-text input for the opening message (the
  agent's recap always restates the fixed corridor regardless of what's typed —
  see Out of Scope)
- Confirm-before-search gate
- Pattern 2 search/retain/display, both destinations
- User-reported resolution with backup-pick fallback on booking failure
- SQLite case persistence (case ID, fixed preferences, both destinations' retained
  picks, resolution status)
- JWT signed link via Resend for resuming a case on a different device
- Public GitHub repo, 500-word write-up, 60-second demo

## Explicitly out of scope for V1

- Any flight search, tracking, or booking
- Proactive/unprompted flight-clearance checking — resolution is purely user-reported
- Cancellation-deadline tracking or pre-confirmation reservation holds (moot under
  Pattern 2 — nothing is reserved until the outcome is known)
- Telegram bot and Claude Connector surfaces (considered, deferred — see Decision Log)
- More than 2 candidate destinations, multi-night stays, or true freeform
  destination/date parsing — the corridor is hardcoded, not generalized. Free
  typing in the chat input is a UX affordance, not a parser: the agent's recap
  always restates Paris/Barcelona regardless of what's typed.
- Orizn API or any other third-party data source
- Invitation-letter drafting (leftover exclusion from an earlier, abandoned visa-
  concierge concept — not applicable here, kept for clarity)

## Open technical risks — verify early, before building on top of them

1. Does RouteStack's hotel search return usable near-term/last-minute inventory,
   with free-cancellation data still present that close to arrival?
2. Does hotel search support filtering/sorting by proximity to a landmark or
   airport, or does this need to be computed from returned coordinates?
3. Does the 3★ filter return reasonable results for both Paris and Barcelona?

Test these with direct sandbox calls before wiring the confirm-before-search gate
or the UI around them.

## Decision log (why, not just what)

- **Pattern 2 over a hold-then-resolve pattern:** hotel free-cancellation deadlines
  are typically pegged to check-in time, not booking time. A same-day hold could
  already be past its free-cancellation window by the time it needs cancelling.
  Pattern 2 removes that risk and matches how non-rev travelers actually behave —
  research, wait, book the moment the outcome is known.
- **Standalone website over Telegram or a Claude Connector:** a Telegram bot adds a
  transport-adapter layer on top of identical backend work, without changing
  capability. A Claude Connector means the user is talking to Claude itself, not
  this app's own system prompt — the confirm-before-search gate would have to be
  rebuilt through tool descriptions instead of a system prompt this project fully
  owns. Both are reasonable V2 ideas, neither is worth the V1 build time/control cost.
- **This whole project supersedes an earlier Schengen-visa-concierge concept**
  (Kazakhstan→France corridor, visitor/host flow, invitation-letter drafting).
  That concept was fully abandoned, not partially merged — don't resurrect pieces
  of it (visa rules, purpose-inference clarifying question) without explicit instruction.

## Future roadmap (post-hackathon, not V1)

- **Surfaces:** Telegram bot on the same backend; a Claude Connector version
  (local Desktop config first, official remote Custom Connector later if a public
  endpoint is worth maintaining)
- **Generalization:** freeform destination and date input with real parsing,
  beyond 2 hardcoded candidate destinations, multi-night stays
- **Pattern upgrade:** if RouteStack ever exposes a true non-committal hold/quote
  primitive (price-lock without a real reservation), revisit Pattern 2 vs. a
  proper Pattern 3 — don't build toward this until it's confirmed to exist
- **Bonus hotel signals:** last-minute deal flagging, late-checkout availability
- **Distribution:** the realistic path to meaningful usage is airline-employee
  partnerships (offered as a travel-benefit perk) rather than direct-to-consumer
  growth — this audience doesn't discover apps through normal channels
- **Monetization:** commission share on hotel bookings via RouteStack's partner
  terms — unit economics look workable at a few hundred to low-thousands of
  active repeat users; this is a sustainable niche product, not a venture-scale one
