# matbyus — documentation index

matbyus is an ecommerce platform for the Indian construction trade. It sells **materials** (cement,
steel, bricks, tiles, fittings) and **services** (site work, labour, contracting) to **both business
buyers** (contractors, builders, dealers) **and individual buyers** (homeowners, self-builders).

It is built for India: prices in INR with Indian digit grouping, GST with HSN and SAC codes, GSTIN
and PAN on business accounts, Indian addresses and mobile numbers, IST, and a mobile-first layout.

Live at **https://matbyus.vercel.app** · 211 tests passing · last updated 2026-11-24.

| Document | What it covers | Status |
|---|---|---|
| [Who can see and do what](permissions.md) | The three roles, the whole permission matrix, where each control lives | v2.0 — **built and live** |
| [Reference data lives in the database](lookups.md) | Roles, menus, units, states and the order status machine as tables, not constants | v1.0 — **built and live** |
| [The QR handover](handover.md) | The code a customer scans to confirm collection, and why it is not the order reference | v1.0 — **built and live** |
| [Messages, bids, basket and notifications](marketplace.md) | The rest of Phase 2: negotiation, a basket spanning owners, and in-app notifications | v1.0 — **built and live** |
| [FSD — Phase 3: AI assistance](FSD-phase-3-ai.md) | Draft a listing, search in plain words, plan materials, translate a message, advise on an offer | v1.0 — **built; live once `ANTHROPIC_API_KEY` is set** |
| [TSD — Phase 3: AI assistance](TSD-phase-3-ai.md) | One door to the model, schemas from the database, limits, usage without content | v1.0 — **built** |
| [FSD — Phase 1: accounts and catalog](FSD-phase-1-accounts-and-catalog.md) | Accounts, roles, catalogue, GST pricing, theme | v1.1 — **built and live** |
| [TSD — Phase 1: accounts and catalog](TSD-phase-1-accounts-and-catalog.md) | Schema, APIs, session design, GST handling, theme | v1.1 — **built and live** |
| [FSD — Phase 2: marketplace](FSD-phase-2-marketplace.md) | Many owners, negotiation and bids, messages, orders, QR handover, platform reporting | Draft v1.0 — **partly built**, see below |
| [TSD — Phase 2: marketplace](TSD-phase-2-marketplace.md) | Role boundary, owner scoping, bid state machine, order and GST schema, handover tokens | Draft v1.0 — **partly built**, see below |

> The Phase 2 documents call the platform role `superadmin`. In the built system it is `admin`.
> [permissions.md](permissions.md) uses the built names and is the one to trust on roles.

## What is built

### Phase 1 — all of it

Accounts with customer and business types, GSTIN and PAN validation, business approval, the
catalogue with GST-inclusive retail and GST-exclusive trade pricing, the admin product and category
screens, and the yellow/black mobile-first front end with a bottom tab bar and a More hub.

### Phase 2 — the parts that exist

| Built | Where |
|---|---|
| **Three roles**: customer, owner, admin | `mb_roles`, `api/_roles.js`, [permissions.md](permissions.md) |
| Owner onboarding — a customer asks, an admin approves or rejects | `POST /api/auth?action=request-owner`, `POST /api/admin?resource=owners` |
| Only an admin can create or remove an admin, and never the last one | `api/admin.js` |
| Per-owner listings, scoped in the SQL | `mb_products.owner_id` |
| Orders, priced by the server, with an order code and a GST split | `mb_orders`, `api/orders.js` |
| Orders received, with accept / dispatch / collect / cancel | `GET`/`POST /api/admin?resource=orders` |
| Per-owner GST: the owner's own registered state decides CGST+SGST against IGST | `sellerStateFor()` in `api/orders.js` |
| The owner list with how much each has sold, and the join queue | `GET /api/admin?resource=owners` |
| Menu permissions per role, with the always-on guarantee | `mb_menus`, `mb_role_menus` |
| **The QR handover** — the seller shows a code, the customer scans it | `mb_order_handover_tokens`, `qr.js`, [handover.md](handover.md) |
| **Messages** between a customer and an owner, one thread per listing | `mb_conversations`, `mb_messages`, `api/messages.js` |
| **Bids** — counter-offers back and forth, acceptance becomes an order | `mb_bids`, `mb_bid_moves`, `api/bids.js` |
| **A basket spanning owners**, split into one order per owner at checkout | `?action=checkout` in `api/orders.js` |
| **In-app notifications** on an order, a message or a bid move | `mb_notifications`, `api/notifications.js` |
| All reference data in the database | [lookups.md](lookups.md) |

### Phase 2 — not built

Nothing from the FSD remains unbuilt except what §6 rules **out of scope**: payments, delivery and
e-way bills, returns, ratings, attachments in messages, push or email delivery of a notification,
and commission. Every one of those is deliberate, not a gap.

The handover panel still does not auto-refresh when a customer scans — it says so and offers a
Refresh — since that would need polling, and there is no push channel in Phase 2 (L4).

## Reading order

Read the FSD first. Every design decision in the TSD carries the `FR-` or `NFR-` identifier it
satisfies, and the TSD closes with a traceability matrix covering every requirement in the FSD.
For anything about roles, read [permissions.md](permissions.md) — it describes what is live.

## The code

| Area | Files |
|---|---|
| Schema | `scripts/migrations/0000_baseline.sql` … `0005_lookups.sql`, applied forward-only |
| Reference data | `api/_lookups.js`, `api/meta.js` |
| India: GSTIN, PAN, PIN, mobile, paise, GST, formatting | `api/_india.js` |
| Auth and the permission boundary | `api/_lib.js`, `api/_db.js`, `api/_roles.js` |
| Endpoints | `api/auth.js`, `api/catalog.js`, `api/admin.js`, `api/orders.js`, `api/categories.js`, `api/meta.js`, `api/health.js` |
| Storefront | `index.html`, `style.css`, `app.js`, `icons.js`, `qr.js` |
| Negotiation and messaging | `api/messages.js`, `api/bids.js`, `api/notifications.js`, `api/_notify.js` |
| Operator scripts | `scripts/migrate-db.mjs`, `scripts/admin/create-admin.mjs`, `scripts/admin/reset-password.mjs` |
| Tests | `test/` — 187 across India, auth, catalog, categories, admin, orders, checkout, store orders, roles, permissions, lookups, handover, QR, messages, bids, notifications, schema |

Run the suite with
`docker run --rm -v "$PWD:/app" -w /app node:20-alpine node --test --test-concurrency=1 test/`.

## Still open

- **`MB_SELLER_STATE_CODE` is unset.** Only house listings — the eleven seeded products with no
  owner — depend on it, and their orders record `tax_split = 'unsplit'`. An owner's own registered
  state decides theirs, so this matters less than it did, but house orders still carry no regime.
- **The eleven seeded products have no owner.** They are treated as the house, which is a defensible
  answer rather than a decision taken. Moving any of them to an owner is a product call.
- **Nothing has been pushed to GitHub.** github.com is TLS-blocked on this machine; commits are local
  on `claude-dev` and deployment goes straight to Vercel.
- The palette contrast figures in TSD Phase 1 §8.2 are computed rather than measured with a tool.
- One test, *a stale session browses as a visitor*, failed once in a full run some days ago and has
  passed in every run since, alone and together. It is a flake that has not been explained.
