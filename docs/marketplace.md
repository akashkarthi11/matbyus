# Messages, bids, the basket, and notifications

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |
| Implements | [FSD Phase 2](FSD-phase-2-marketplace.md) FR-23, FR-24, FR-25.1-2, FR-28 |
| Code | `api/messages.js`, `api/bids.js`, `api/orders.js` (`?action=checkout`), `api/notifications.js`, `api/_notify.js` |
| Migrations | [`0007_messages.sql`](../scripts/migrations/0007_messages.sql), [`0008_bids.sql`](../scripts/migrations/0008_bids.sql), [`0009_notifications.sql`](../scripts/migrations/0009_notifications.sql), [`0010_messaging_menus.sql`](../scripts/migrations/0010_messaging_menus.sql) |
| Tests | `test/messages.test.mjs`, `test/bids.test.mjs`, `test/checkout.test.mjs`, `test/notifications.test.mjs` |

---

## Messages (FR-23)

One conversation per `(customer, owner, listing)` — or per `(customer, owner)` when it is not about
a particular listing — enforced by two partial unique indexes rather than one plain one, because a
plain `UNIQUE` on `(customer_id, owner_id, product_id)` treats every `NULL` listing as distinct from
every other and would let the pair accumulate an unbounded number of "general" threads.

An unread count is "messages from the other side newer than my last read", answered from two
timestamp columns on the conversation (`customer_last_read_at`, `owner_last_read_at`) rather than a
per-message read flag — one index-backed query, no scan (NFR-23).

**A superadmin reads none of it.** `api/messages.js` refuses `isAdmin(account)` outright; there is no
admin-reachable query against `mb_messages` anywhere in the codebase. What an admin may see is a
count, already reported by `GET /api/admin?resource=owners`. This is FSD L1, and it is enforced by
absence, not by a check that could be loosened later.

## Bids (FR-24)

The one rule that decided the shape of this feature: *"back-and-forth is the normal case and is not
limited to one round"* (FR-24.4). A bid's `status` — `open / countered / accepted / rejected /
withdrawn / expired / ordered` — is not the only state that matters, because `countered` is reached
both by an owner's first counter and by a customer's counter-to-a-counter. A separate `turn` column
says whose move it actually is.

**This is deliberately not a generic transitions table**, unlike order status (`mb_order_transitions`,
migration 0005). An order's moves are pure data: *from state X, action Y, to state Z*. A bid's moves
also depend on turn, which a `(from, to)` pair cannot express without inventing a parallel status per
turn. So `TRANSITIONS` in `api/bids.js` is code — the same reasoning that keeps the role boundary in
`api/_roles.js` rather than a table. The bid *status labels* are still reference data and live in
`mb_lookups` like every other small enum.

Accepting a bid produces an order **at the bid's agreed price**, never the listing's current one — a
bid is a promise about a specific number, and the listing may have moved since (D-26, extended).
`insertOrder()` is shared by the single-item buy flow, the basket checkout, and bid acceptance, so
there is exactly one place that turns a product and a quantity into money.

A bid past its expiry becomes `expired` the moment anyone next looks at it or acts on it — there is
no cron. The move is still recorded with its timestamp, so the history says *when* it lapsed, not
only that it eventually did.

## A basket spanning owners (FR-25.1-2)

`POST /api/orders?action=checkout` takes `{ items: [{slug, qty}], ...address }` and groups the
resolved lines by `owner_id` before pricing or writing anything. Each owner's lines become one order,
through the same `insertOrder()` the single-item path uses.

**There is no cross-owner transaction.** If one owner's lines are refused — out of stock, a stale
price, a suspended account — that owner's lines are named in the response's `errors` array and every
other owner's order still goes through, exactly as FSD Phase 2 §8 specifies: *"that owner's lines are
refused by name; the rest proceed."* The atomic unit is one order, the same as it was before a basket
existed; nothing here wraps multiple orders in one database transaction, because the spec explicitly
wants partial success, not all-or-nothing.

## Notifications (FR-28)

One function, `notify(db, userId, kind, title, opts)`, called from the four places the FSD names: an
order is placed, an order's status changes, a message is sent, a bid moves. Every other handler
imports this rather than writing its own `INSERT INTO mb_notifications`, so *"a notification is
addressed to exactly one account"* (FR-28.5) stays true in one place rather than four.

A house listing has no owner to notify; `notify()` treats a null recipient as "nobody to tell", not
an error. No push, no email, no SMS (FR-28.2, L4) — this is read by the signed-in account loading its
own list, with a bell and a badge in the header.

**What is still missing:** the seller's handover panel does not auto-refresh when a customer scans —
see [The QR handover](handover.md) — because that would need polling, and there is no push channel
in this phase.

## Verified live against production, 2026-11-24

```
catalog seller                 200 {"ownerId":"...","name":"Test Owner"}
customer opens conversation    201
customer sends                 201
owner sees conversation        200 1 conversation, unread=1
owner replies                  201
customer notifications         200 unread=1
customer bids                  201 open ₹380.00
owner counters                 200 countered, turn=customer
customer accepts                200 MB-GC6R-G2PR ₹25,088.00, soldBy=Test Owner
basket checkout                201 2 order(s), errors=[]
admin reads messages            403 You do not have access to this.
admin reads bids                403 You do not have access to this.
owner notifications             200 unread=5, "New order MB-K3HV-68HY"
```

187 tests pass. Migrations 0007–0010 applied; deployed.
