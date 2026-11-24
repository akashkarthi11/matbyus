# Who can see and do what

| | |
|---|---|
| Version | 2.0 |
| Date | 2026-11-24 |
| Covers | Three roles — customer, owner, admin — all **built and live** |
| Updated | 2026-11-24 — the QR handover is built; see [The QR handover](handover.md) |
| Changed in 2.0 | `owner` is a real role. What 1.0 described as "Phase 2, not built" now exists; what it called `superadmin` is `admin`. |

---

## The one rule to hold on to

**Hiding a menu is presentation. It is never protection.**

An admin can switch menus off for a role in **Permissions**, and they will disappear from that
role's app. That is all it does. Every endpoint checks the caller's role for itself, so:

- switching a menu **off** stops nothing that an API would otherwise allow;
- switching a menu **on** grants nothing that was previously refused.

If you want someone kept out of something, the control is the role, not the menu. This is why the
`admin` role cannot be tailored at all: an administrator able to hide their own Permissions menu
could lock themselves out of undoing it.

## The three roles

They are rows in `mb_roles`, not constants — see [Reference data lives in the database](lookups.md).

| Role | Is | Lands on | Accounts today |
|---|---|---|---|
| `admin` | The platform. The brief's "OG admin". | Dashboard | `karthickkeyan303@gmail.com`, `vijumohan0905@gmail.com`, `karthikeyans@growx.global` |
| `owner` | A seller. | Orders received | `owner@gmail.com` |
| `customer` | A buyer. | Materials | everyone else, including `customer@gmail.com` |

There is **no way to become an owner except an admin approving one**, and the database enforces it:
`mb_users_owner_role_check` refuses any row where `role = 'owner'` and `owner_status <> 'approved'`.
Registration always produces a customer, whatever the request body says.

## The difference between owner and admin, in one line

Both reach the same seller screens. An owner's queries are narrowed to their own id; an admin's are
not narrowed at all. That is `ownerScope()` in `api/_roles.js`, and it is the only place the
distinction is expressed — the narrowing goes **into the SQL**, so there is no second, unscoped code
path for an owner to fall into.

## What a customer can see and do

| | |
|---|---|
| **Menus** | Materials · Services · My orders · My account — of which *My account* is always on |
| Browse the catalogue | Yes, including signed out. Every owner's listings, in one list |
| See retail prices with GST included | Yes |
| See trade prices | Only once their business account is **approved**, and then the headline is GST-exclusive |
| Place an order | Yes, signed in. Buying signed out asks them to sign in and returns them to that order |
| See who an order is from | Yes — "Sold by", on the order and in the list |
| See their own orders | Yes |
| See **anyone else's** order | No — another customer's reference returns **404**, not 403, because a 403 would confirm it exists |
| Cancel an order | Only while it is `placed`, which is a row in `mb_order_transitions`, not a literal |
| Confirm collection | Yes, by scanning the code on the seller's screen, or typing it. Recorded as a **scan**, naming them — evidence they were there, as against the seller's word |
| Mint their own collection code | No — 403. A customer who could issue one could close their own order from anywhere |
| Use a code for someone else's order | No — **404**, and the code stays unspent for the customer it belongs to |
| Reach any seller or platform route | No — 403 on every one of them, including a resource that does not exist, so nothing is learned from the error |
| Ask to sell here | Yes — **My account → Sell on matbyus**. It records the request. An admin decides |
| Become an owner or admin by registering | No. The role is a literal in the INSERT, never read from the body |

## What an owner can see and do

| | |
|---|---|
| **Menus** | Orders received · My listings · My sales · My account — *Orders received* and *My account* are always on |
| Orders placed with them | Yes, and only those. The status counts on the filter chips are scoped too, not just the list |
| **Another owner's** order | No — **404**, and the refusal does not report its status either |
| Move their own order | Accept, dispatch, mark collected, cancel with a reason. A move out of turn is refused and names the state the order is really in |
| Show the collection QR | Yes, for their own orders, once accepted or dispatched. Single use, two minutes, replaced each time it is shown — see [The QR handover](handover.md) |
| Show a QR for **another owner's** order | No — 404, and no code is issued |
| Their own listings | Create, edit, price, put live, take offline |
| **Another owner's** listing | No — 404 on read, edit, activate and deactivate alike, and nothing is written |
| Create a listing under another owner | No. `ownerId` in the body is ignored for an owner: the listing is theirs |
| Categories | Read, so they can file a listing under one. Not create, rename or retire |
| Platform totals, other owners, the owner list | No — 403 |
| Customers, business approvals, permissions | No — 403 |
| Make themselves or anyone else an admin | No — 403, and nothing is written |
| Their GST regime | Their **own registered state** decides CGST+SGST against IGST, captured on the order at placement. Not one setting for the whole platform |

## What an admin can see and do

| | |
|---|---|
| **Menus** | Dashboard · Orders · Owners · Products · Categories · Customers · Business approvals · Permissions. Always all of them |
| Orders | Every order, across every owner, with who is selling it and who bought it |
| Owners | Who sells here, how many listings, how many orders, **how much they sold**, and who is asking to join |
| Approve or reject an owner | Yes. Approving creates the owner; rejecting moves role and status together in one statement |
| Make another admin | Yes — and **only** an admin can. "Only OG admin can add OG admin" |
| Remove an admin | Yes, except their own role, and never the last one. matbyus refuses to be left with no administrator |
| Products and categories | Create, edit, put live, take offline. May attribute a listing to an owner, or leave it with the house. Never hard-delete |
| Customers | List, filter, search, and open one to see their business details and status history |
| Business approvals | Approve or reject, with a note the customer can read |
| Reset a customer's password | Yes, while signed in. It signs that account out everywhere |
| Permissions | Choose which menus the customer and owner roles see |
| Read a customer's password | No. Passwords are scrypt-hashed and nothing can recover one |
| Read a conversation between an owner and a customer | Not applicable yet — messages are not built. When they are, this stays **no**: see [FSD Phase 2 L1](FSD-phase-2-marketplace.md) |

### A note on "how much they sold"

The Owners screen totals what customers agreed to pay, excluding cancelled orders. It is **not
revenue to matbyus**: nothing writes commission yet (FSD Phase 2 C4), so the platform's own cut is
deliberately absent rather than guessed at.

## Changing a role signs that account out

Every role change raises `session_version`, which revokes every session that account holds. That is
the point, not a side effect: a session minted as a customer carries the customer role, so the new
menus and the new scoping only take effect on a session minted after the change. The screens say so
("They were signed out; the owner screens appear on their next sign-in").

## Listings with no owner

`mb_products.owner_id` is nullable and stays nullable. A null owner means **the house**: the eleven
products seeded before owners existed, and anything an admin lists directly. Making it `NOT NULL`
would force a fictional owner onto those rows, and a fiction in a foreign key is worse than a null
every query already handles. The Products screen shows them as "matbyus".

A house order has no owner, so `MB_SELLER_STATE_CODE` is still what decides its GST regime. That
variable is **not set**, so house orders record `tax_split = 'unsplit'` — the tax is charged and
correct, but matbyus does not claim it is CGST+SGST or IGST, because that depends on a state it has
not been told.

## Where each control actually lives

| Control | Enforced by |
|---|---|
| Role of a new account | `api/auth.js` — a literal in the INSERT, never read from the body |
| Being an owner at all | `mb_users_owner_role_check` — the database refuses an unapproved owner |
| Which roles reach which resource | the `READ` / `WRITE` tables in `api/admin.js`, checked before a body is read |
| An owner seeing only their own rows | `($n::uuid IS NULL OR owner_id = $n)` in the statement itself |
| Not revealing that a row exists | 404 instead of 403 on someone else's row, and no status in the refusal |
| An order moving only where it may | `mb_order_transitions`, with the expected state in the `WHERE` clause |
| A collection code being spent once | `mb_handover_one_live_idx`, plus claiming the code and moving the order in one statement |
| Trade pricing | `isApprovedBusiness()`, server-side; the public catalogue URL cannot produce a trade price at all |
| Session validity | Signature, then expiry, then `session_version` |
| Menu visibility | `mb_menus` plus `mb_role_menus`, via the Permissions screen. **Presentation only** |

## What the tests prove

156 tests. The ones that matter most here:

- **Hiding a menu removes no access.** Every useful customer menu is switched off, and the customer
  still places and reads orders — and still gets 403 on every seller and platform route. If this
  ever fails, the menus have quietly become a permission system and the real checks have rotted.
- **An owner given every menu they have still reaches no admin route**, and cannot grant themselves
  anything.
- **One owner cannot read, edit, hide or publish another's listing** — 404, and nothing is written.
- **One owner cannot move another's order**, and the refusal does not leak its status.
- **A listing an owner creates is theirs, whatever the request body says.**
- **Registration cannot produce an owner or an admin**, however the request is shaped.
- **The database itself refuses an owner who was never approved.**
- **matbyus cannot be left with no administrator**, and nobody can revoke their own role.
- **GST splits on the owner's own state**, and a house listing with no state is recorded `unsplit`.
- **A collection code cannot be replayed, guessed, reused, or spent by another customer**, and
  overhearing the order reference is not enough — it is a separate secret.
- **The QR encoder's output is decoded by an independent decoder** and matched module for module
  against an independent encoder, at every version and every mask.
- Another customer's order is a **404**. A doctored price in a request body is ignored. An order
  cannot be moved twice by a double tap.

Run them with
`docker run --rm -v "$PWD:/app" -w /app node:20-alpine node --test --test-concurrency=1 test/`.
