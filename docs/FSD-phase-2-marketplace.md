# FSD — matbyus Phase 2: marketplace, negotiation and orders

| | |
|---|---|
| Document | Functional Specification |
| Version | 1.0 (draft, awaiting approval) |
| Date | 2026-11-23 |
| Market | India — GST per owner, INR |
| Builds on | [FSD Phase 1](FSD-phase-1-accounts-and-catalog.md) v1.1, which is built and deployed |
| Repository | `akashkarthi11/matbyus`, branch `claude-dev` |

> **Build status, 2026-11-24 — partly built.** The three roles exist and are live: `customer`,
> `owner` and `admin`, where `admin` is what this document calls `superadmin`. Owner onboarding,
> per-owner listings, per-owner order scoping, per-owner GST, the owner list with sales totals, and
> admin creation and removal are all built, and so is the **QR handover** (FR-29.9) — see
> [The QR handover](handover.md). As of 2026-11-24, **messages (FR-23), bids (FR-24), the
> multi-owner basket (FR-25.1-2) and in-app notifications (FR-28) are built too.** What remains is
> only what §6 rules out of scope: payments, delivery, returns, ratings, message attachments, push
> or email delivery, and commission. See [Who can see and do what](permissions.md) for the live
> matrix and [the documentation index](index.md) for the line-by-line split.

---

## 1. What changes

Phase 1 is one shop. Phase 2 makes matbyus a **marketplace**: many owners sell, and a customer buys
from whichever owner they choose. On top of that it adds **negotiation** — a customer can ask an
owner for a better price, and the two settle it in a conversation — and the **orders** that make
both negotiation and sales reporting mean anything.

Three things follow that are easy to miss, and all three are decided in this document:

1. **GST stops being the platform's.** Every owner invoices under their own GSTIN from their own
   state, so place of supply is a property of each order, not a deployment setting. The Phase 1
   settings `MB_SELLER_GSTIN` and `MB_SELLER_STATE_CODE` are retired.
2. **A basket can span owners, an order cannot.** One order belongs to one owner, because one owner
   has to invoice it and fulfil it. A basket holding three owners' goods becomes three orders.
3. **Every query becomes owner-scoped.** An owner must never read another owner's sales, bids or
   messages. This is the largest new risk in the system — see §10 R1.

## 2. Roles

Phase 1 had `customer` and `admin`. Phase 2 has three tiers.

| Role | Who | What they can do |
|---|---|---|
| `superadmin` | Karthi and Viju — the platform | Everything below, plus: see every owner, see how much each owner sold, approve or reject owners, and create other superadmins |
| `owner` | A seller on the platform | List their own products, set their own prices, answer bids and messages, see **only their own** orders and figures |
| `customer` | A buyer | Browse every owner's listings, buy from any of them, bid, and message owners |

The Phase 1 `admin` role is retired. The three existing accounts become `superadmin` (§9).

**A superadmin is created only by a superadmin.** There is no registration path, no invite link and
no setting that produces one. The Phase 1 rule that registration can never create a privileged
account is extended, not relaxed.

## 3. Functional requirements

### FR-20 — Owner onboarding

1. Anyone may **request** to become an owner, giving a shop name, GSTIN, PAN, state, address and
   contact. Requesting is open; being one is not.
2. A request is `pending` until a superadmin approves or rejects it. A rejection carries a reason
   the requester can read, and they may correct and resubmit, which returns them to `pending`.
3. While `pending` or `rejected`, the account **cannot list, sell, or see any owner screen**. It
   behaves exactly as a customer account.
4. GSTIN is validated as in Phase 1 (FR-6.2): format, checksum, and the state code must agree with
   the address state. For an owner the GSTIN is **required**, not optional — they issue tax invoices.
5. On approval the account gains the owner role and its own seller area. Nothing it listed before
   approval exists, because it could not list.
6. Every status change records who made it and when.
7. A customer account and an owner account may be the same login: an owner can also buy.

### FR-21 — Superadmin management

1. Only a `superadmin` may grant or revoke the `superadmin` role, and only to an existing account.
2. A superadmin cannot remove their own superadmin role, so the platform can never be left without one.
3. The system refuses to reduce the number of superadmins below one.
4. Every grant and revocation is recorded with the actor and the time.

### FR-22 — Listings belong to owners

1. Every product belongs to exactly one owner. The owner sets its price, stock, unit and GST details.
2. Two owners selling the same cement have two listings. The catalogue shows both, each labelled
   with its owner, and the customer chooses.
3. An owner may only create, edit, activate or deactivate **their own** listings.
4. A superadmin may deactivate any listing — for example an unsafe or mislabelled one — but may not
   edit its price. Price is the owner's.
5. Deactivating an owner (suspension) hides every listing of theirs from customers at once, without
   deleting anything.
6. Catalogue search and filters work across all owners. Results may be filtered to one owner.

### FR-23 — Messages between a customer and an owner

1. A customer may open a conversation with an owner, optionally about a particular listing.
2. There is one conversation per customer, owner and listing, so a negotiation has one place to live.
3. Either side may send a message. Both see the whole history in order, with times in IST.
4. Each side sees an unread count, and a message is marked read when its thread is opened.
5. A customer sees only their own conversations. An owner sees only conversations addressed to them.
   **A superadmin does not read conversations** — they see that a conversation exists and how many
   messages it holds, not what was said (§10 L1).
6. Messages are text. No attachments in Phase 2.
7. A message is never edited or deleted; a correction is another message.

### FR-24 — Bids

1. On any fixed-price listing a customer may place a **bid**: a price per unit and a quantity.
2. A bid is attached to the conversation of FR-23, so the haggling and the numbers sit together.
3. A bid's state is one of `open`, `countered`, `accepted`, `rejected`, `withdrawn`, `expired`, `ordered`.
4. The owner may **accept**, **reject**, or **counter** with their own price. A counter moves the bid
   to `countered` and it is then the customer's turn, who may accept, reject or counter again.
   Back-and-forth is the normal case and is not limited to one round.
5. Every move is recorded: who moved, from what price to what price, when, and any note. The history
   is append-only and visible to both sides of that bid.
6. A bid carries an expiry. An owner's price cannot be held open forever against a moving market.
   When it passes, the bid becomes `expired` and can no longer be accepted by either side.
7. An **accepted bid reserves that price and quantity for that customer until the bid expires.** It
   does not reserve stock in Phase 2 — see L2.
8. Accepting produces an order at the agreed price (FR-25). Once ordered, the bid is `ordered` and
   cannot be reused.
9. A customer may withdraw their own bid while it is `open` or `countered`.
10. A quote-priced listing takes a bid with no starting price — that is what "request a quote" means.
11. A bid is visible only to the customer who made it and the owner who received it.

### FR-25 — Basket and orders

1. A customer collects items in a basket. The basket may hold items from several owners.
2. **At checkout the basket splits into one order per owner.** Each order is invoiced and fulfilled
   by that owner. The customer sees one checkout and the resulting orders listed separately.
3. An order records, per line: the listing, quantity, unit price excluding GST, the GST rate, the
   tax computed, and the line total. It records the bid it came from, where it came from one.
4. Prices are captured onto the order at the moment it is placed. A later price change by the owner
   never alters a placed order.
5. Order status is one of `placed`, `confirmed`, `dispatched`, `collected`, `cancelled`.
   The owner accepts a `placed` order, which makes it `confirmed`, and may move it to `dispatched`.
   It reaches `collected` only by the handover confirmation of FR-29. The customer can cancel only
   while it is `placed`; the owner may reject a `placed` order, which cancels it with a reason.
6. A customer sees their own orders. An owner sees orders placed with them. A superadmin sees all.
7. **No payment is taken in Phase 2.** An order is a commitment to buy, settled between the customer
   and the owner offline. See L3.

### FR-28 — Notifications

1. When a customer places an order, the **owner is notified**. When an owner accepts, rejects or
   moves an order, the **customer is notified**. The same applies to a new message and to every bid
   move.
2. Notification is **in-app**: a badge with a count, and a list of what happened, newest first.
   There is no email or SMS in Phase 2 — the provider decision is still open (L4).
3. A notification names what happened, which order or listing it concerns, and when, in IST.
4. Opening the item clears it. A count never persists after the thing has been seen.
5. A notification is addressed to exactly one account. An owner is never notified about another
   owner's order.

### FR-29 — Order code and QR handover

Every order carries a short **order code** that both the customer and the owner can see and quote —
over the phone, at a gate, on a delivery note. It is the human-readable handle for the order.

1. The code is generated when the order is placed and shown to both sides immediately.
2. It is short enough to read aloud, and not sequential, so one code does not reveal another order's
   code or how many orders the platform has taken.
3. **Handover is confirmed by scanning.** On the owner's screen for that order, a **QR code** is
   displayed. The customer, signed in on their own phone, scans it, and the order is confirmed as
   handed over.
4. The QR encodes a **single-use, short-lived token** for that order — not the order code. A code
   that could simply be read and typed would let either side confirm a handover that never happened.
5. A scan is accepted only when **all** of these hold: the scanner is signed in as that order's
   customer, the token matches that order, the token has not been used, and it has not expired.
   Otherwise the order does not move, and the customer is told plainly which condition failed —
   except for "wrong customer", which says only that the code is not valid for this account.
6. The owner's screen can regenerate the QR. Regenerating invalidates the previous token, so an
   old screenshot cannot be used later.
7. On a successful scan the order becomes `collected`, with the time and the confirming account
   recorded. Both sides see it at once.
8. A handover can only be confirmed for an order that is `confirmed` or `dispatched`. A `placed`
   order has not been accepted yet; a `cancelled` one has nothing to hand over.
9. Where scanning is impossible — no camera, bad light, a damaged screen — the owner may mark the
   order delivered manually. That is recorded as a **manual confirmation, naming the owner who did
   it**, and is deliberately distinguishable in the record from a customer scan. The scan is proof
   that the customer was there; a manual mark is the owner's word.

### FR-26 — GST on an order

1. The **owner** is the supplier. Their GSTIN and state appear on the order.
2. Place of supply is the delivery address state for goods.
3. Where the owner's state and the place of supply are the same, tax is **CGST + SGST**, each half
   the product's rate. Where they differ, it is **IGST** at the full rate.
4. The split is computed per line, from the line's own GST rate, and stored on the order so it can
   never drift from what the customer agreed.
5. Rounding follows Phase 1 FR-12.6: once, half-up, to the paisa, per line.
6. An order whose owner has no valid GSTIN cannot be placed. An owner without one cannot be approved
   (FR-20.4), so this is a guard, not a workflow.

### FR-27 — What a superadmin sees

1. A list of every owner: shop name, GSTIN, state, status, date joined, number of live listings.
2. Per owner: **how much they have sold** — order count and total value, by period, taken from placed
   orders rather than anything self-reported.
3. Platform totals: owners, listings, customers, orders, value, open bids.
4. The owner approval queue (FR-20).
5. Counts of conversations and bids per owner, **not their contents** (FR-23.5).
6. Every figure a superadmin sees is derived from orders. Nothing is entered by hand.

## 4. What a customer sees that is new

A listing now shows which owner sells it, with their shop name and state. A product page offers
"Ask for a better price", which opens the conversation and the bid form. "My orders" and
"My conversations" appear in the account area.

## 5. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-20 | Every read and write of a listing, order, bid or message is scoped to the caller's own rows in the query itself, never by filtering after the fact. |
| NFR-21 | A request that names a row belonging to someone else returns 404, not 403 — otherwise the response reveals that the row exists. |
| NFR-22 | Money on an order is exact to the paisa, computed as in Phase 1 §7.1, and stored, never recomputed for display. |
| NFR-23 | The unread count and the owner sales figures must not require a scan of every message or order; both are indexed for the query that serves them. |
| NFR-24 | No message body, bid note, GSTIN or order total appears in a log line. |

## 6. Out of scope for Phase 2

Payments and settlement; delivery, freight and e-way bills; returns and refunds; ratings and reviews;
attachments in messages; push or email notification of a new message or bid; commission (§7 C4);
multi-user owner accounts; stock reservation (L2); dispute handling.

## 7. Settled decisions

| # | Decision |
|---|---|
| C1 | Each owner has their own listings. Two owners selling the same cement are two listings, not one product with two offers. Chosen over a shared catalogue on the owner's instruction, 2026-11-23. |
| C2 | An accepted bid becomes a priced order, and owners may counter. |
| C3 | Ordering is built in this phase, because sales figures and binding bids are meaningless without it. |
| C4 | **No commission.** Owners keep the whole sale. The order schema leaves a nullable field so adding one later is a migration, not a rework. |
| C5 | One order per owner. A basket spanning owners splits at checkout. |
| C6 | GST is the owner's, computed per order from the owner's state and the delivery state. |

## 8. Error and edge behaviour

| Situation | Behaviour |
|---|---|
| Pending owner tries to create a listing | 403. They are not an owner yet. |
| Owner edits another owner's listing | 404, not 403 (NFR-21). |
| Owner opens another owner's order or conversation | 404. |
| Last superadmin tries to remove their own role | 400, states that one superadmin must remain. |
| Customer accepts an expired bid | 409, "That offer has expired." |
| Owner accepts a bid they already rejected | 409, with the current state named. |
| Bid placed on a deactivated listing | 400. |
| Checkout with an empty basket | 400. |
| Checkout where one owner has been suspended mid-basket | That owner's lines are refused by name; the rest proceed. |
| Order placed against a listing whose price changed | Refused with 409 and the new figures; nothing is placed until the customer confirms the real price. The price is never taken from the browser. |
| QR scanned by someone who is not that order's customer | Refused. The message says only that the code is not valid for this account, never that it belongs to someone else. |
| QR scanned twice | Second scan refused — the token is single-use — and the order is reported as already collected. |
| QR from an old screenshot after the owner regenerated it | Refused: regenerating invalidates the previous token. |
| QR scanned for a `placed` order | Refused. The owner has not accepted it yet. |
| Owner marks an order delivered without a scan | Allowed, recorded as a manual confirmation naming the owner, and shown as such rather than as a customer scan. |
| Owner without a valid GSTIN reaches checkout | Cannot happen — they cannot be approved. A guard returns 409 if it ever does. |

## 9. Migration of the live system

Phase 1 is deployed with real accounts, so this phase migrates rather than starts clean.

1. The three existing `admin` accounts — `karthickkeyan303@gmail.com`,
   `karthikeyans@growx.global` and `vijumohan0905@gmail.com` — become `superadmin`.
2. The eleven seeded products have no owner. They are assigned to a first owner account, or
   deactivated, on the owner's instruction before the migration runs. **This must be decided, not
   guessed** — an unowned listing cannot be sold.
3. `MB_SELLER_GSTIN` and `MB_SELLER_STATE_CODE` are removed from the deployment.
4. No existing customer account changes.

## 10. Known limitations accepted for Phase 2

| # | Limitation | Why | Must be fixed by |
|---|---|---|---|
| L1 | A superadmin cannot read conversations, only counts | Owners and customers negotiate prices; a platform that reads those conversations is in a difficult position, and the owner has not asked for it | Only if dispute handling requires it, and then say so to both sides |
| L2 | An accepted bid reserves a price, not stock | Stock reservation needs a hold with its own expiry and a release path, and ordering has to work first | Before stock-outs on accepted bids become a complaint |
| L3 | No payment. An order is a commitment, settled offline | Payment is a separate integration with its own compliance surface | Before the platform handles money |
| L4 | No notification when a bid or message arrives | Needs email or SMS, which is the same unresolved provider decision as Phase 1 L1 and L6 | With the provider decision |
| L5 | Owner sales figures count placed orders, including cancelled ones separately | There is no payment, so "sold" means "ordered". The reports say so on their face | When payment exists |
