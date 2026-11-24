# The QR handover

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |
| Implements | [FSD Phase 2](FSD-phase-2-marketplace.md) FR-29.9 |
| Migrations | [`0002_order_handover.sql`](../scripts/migrations/0002_order_handover.sql), [`0006_handover_tokens.sql`](../scripts/migrations/0006_handover_tokens.sql) |
| Code | [`qr.js`](../qr.js), `api/admin.js`, `api/orders.js`, `app.js` |
| Tests | [`test/handover.test.mjs`](../test/handover.test.mjs) · [`test/qr.test.mjs`](../test/qr.test.mjs) |

---

## What it is for

An order can be closed out two ways, and they are not the same claim:

| | Recorded as | Means |
|---|---|---|
| The seller taps **Collected** | `manual` | The seller's word that the goods went out |
| The customer scans the code on the seller's screen | `scan` | The customer was standing there |

Flattening both into "delivered" would throw away the only difference that matters in a dispute.
`mb_orders` keeps `collected_at`, `collected_by` and `collection_method` apart precisely so the
record says which of the two happened, and who did it.

## The code is not the order reference

This is the whole design, and it is worth stating plainly, because putting the reference in the QR
is the obvious thing to do and it is wrong.

Order references — `MB-TJUD-QETN` — are built to be **read aloud down a phone line**. The alphabet
drops B, I, L, O, S, Z, 0, 1 and 5 for exactly that reason. A reference is therefore something a
customer says out loud, writes on a delivery note, and texts to a site supervisor. Anything that can
be overheard cannot also be the proof of presence.

So the QR carries a **separate secret**:

```
MB1:<order reference>:<handover code>
MB1:MB-TJUD-QETN:JAP4XDC7T4
```

The reference is in there so a scan can be matched to the right order even when the customer opened
the scanner from somewhere else. The ten-character code is the part that proves anything.

## Five properties, each enforced somewhere specific

| Property | Where |
|---|---|
| **Only a seller can mint one** | `READ`/`WRITE` table in `api/admin.js`; an owner is scoped to their own orders, a customer gets 403 |
| **Only at the right moment** | The states are read from the *customer's* `collect` rows in `mb_order_transitions`, so the screen cannot offer a code the scan would be refused at |
| **Short-lived** | 120 seconds by default, clamped to 30–600, `MB_HANDOVER_TTL_SECONDS` |
| **Single use, and only the current one** | A unique index, `mb_handover_one_live_idx`, allows exactly one unspent token per order; issuing a new one deletes the one it replaces, so a photograph of an earlier screen is worthless |
| **Not recoverable from the database** | Only `sha256(code)` is stored. A copy of this table closes nothing |

Why SHA-256 and not scrypt, when passwords here are scrypt-hashed: scrypt's slowness defends a
low-entropy secret people reuse. A handover code is high-entropy, lives two minutes, and works once.
Spending 100ms per scan to protect it would buy nothing.

## Claiming and moving happen in one statement

A second scan of the same code — a double tap, a replay, two phones in the same yard — must find
nothing left to take. So the token is claimed and the order moved in a single statement, with a
data-modifying CTE:

```sql
WITH claimed AS (
  UPDATE mb_order_handover_tokens t
     SET used_at = now(), used_by = $2
    FROM mb_orders ord
   WHERE t.order_id = ord.id
     AND ord.reference = $1 AND ord.customer_id = $2
     AND t.token_hash = $3 AND t.used_at IS NULL AND t.expires_at > now()
   RETURNING t.order_id
)
UPDATE mb_orders o
   SET status = 'collected', collected_at = now(), collection_method = 'scan',
       collected_by = $2, updated_at = now()
  FROM claimed
 WHERE o.id = claimed.order_id AND o.status IN ('confirmed', 'dispatched')
RETURNING o.*
```

Note `ord.customer_id = $2` inside the CTE: the scan is scoped to **the customer's own order**. A
different customer holding the code — photographed, forwarded, shoulder-surfed — gets a 404, not a
403, and the token stays unspent for the real customer.

If the token is valid but the order has moved on, the token is spent and the order is not. That is
the right way round: a spent code cannot be replayed, and the seller can show a new one.

## Which move needs a code is data

`mb_order_transitions.needs_token` is a column. The customer's `collect` rows carry `true`; the
seller's carry `false`, because the manual path is what a yard with a flat phone uses. The front end
reads it from `/api/meta` and opens the camera for any move that needs a code rather than posting a
button press, and the API requires one for the same rows. One source, both sides — the pattern set
out in [Reference data lives in the database](lookups.md).

A test deletes the customer's `collect` rows and watches both the code endpoint and the scan
endpoint return 503, with no code change.

## The encoder

`qr.js` is a QR encoder written for this project: byte mode, error correction level M, versions 1
to 10. It is in the repository rather than imported because a third-party script in the page would
put the rendering of the handover code — and the page's integrity — in someone else's hands. The
square is drawn as inline SVG from the code, not fetched as an image, so the handover code never
appears in a URL, a log or the browser's history.

### How it is verified, and why that matters here

The block, alignment and remainder tables were written from knowledge of the standard, not from a
conformance suite. A wrong row produces a square that **looks like a QR code and scans as nothing**,
which is the kind of bug that is invisible in review and obvious in a yard.

So the tests do not ask the encoder to agree with itself. They:

1. render the output to pixels and decode it with **jsQR**, an independent decoder; and
2. compare every module of every version at every one of the eight masks against **`qrcode`**, an
   independent encoder.

That second check found both real bugs in this file:

- the 15 format bits written least-significant-first instead of most — perfect data, and no scanner
  on earth would read it, because the one thing it could not be told was which mask to undo;
- one module at `(8, size - 8)` left unwritten, because the second format run started at bit 8
  instead of bit 7. **Wrong for four of the eight masks and right by luck for the other four** —
  nothing short of a module-for-module comparison would have caught it before a customer did.

This is a deliberate contrast with the GSTIN checksum in `api/_india.js`, which has no independent
implementation to appeal to and is documented as corroborated rather than proven. Here there was
one, so it was used.

## What a customer sees if the camera will not work

Typing the code is always offered, beside the camera, on the same screen. `BarcodeDetector` is
missing on iOS Safari; a camera can be refused, unavailable in an insecure context, or simply
pointed at a dark yard. An order that cannot be closed is worse than one closed by reading ten
characters aloud — which the alphabet was chosen to make easy.

The seller's screen shows the code in large monospace under the square for exactly that reason.

## Verified live

Against production, 2026-11-24:

```
customer places                201 MB-TJUD-QETN ₹5,040.00
code while placed              409 A collection code can only be shown once the order is
                                   accepted or dispatched. This one is placed.
seller confirm                 200 confirmed
seller dispatch                200 dispatched
customer asks for code         403 You do not have access to this.
seller shows code              200 NMWN3QENHM · expires in 120s
a second code replaces it      200 NMWN3QENHM -> JAP4XDC7T4
scanning the old code          409 That code has expired or has already been used.
scanning a guessed code        409 That code has expired or has already been used.
customer scans                 200 collected · scan
scanning it twice              409 That order is collected. There is nothing to confirm.
customer sees                  200 collected · scan
seller sees                    200 collected · scan
```

## Still open

- **No notification.** The seller's screen does not learn that the customer scanned until it is
  refreshed; the panel says so and offers a Refresh. In-app notifications are unbuilt
  ([FSD Phase 2](FSD-phase-2-marketplace.md)), and polling one order would need an endpoint that
  does not exist yet.
- **The scan is optional.** An order can still be closed manually, which is deliberate — but it
  means `collection_method = 'manual'` will be the common case until customers have the app in
  their hands. The record is honest about which happened; it does not make one of them the rule.
- **No rate limit on scan attempts.** A code is 27^10 ≈ 2×10^14 and lives two minutes, so guessing
  is not the threat; but an endpoint anyone signed in can post to repeatedly is worth a limit
  eventually, like sign-in has.
