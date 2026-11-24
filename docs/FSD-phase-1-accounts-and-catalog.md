# FSD — matbyus Phase 1: accounts and catalog

| | |
|---|---|
| Document | Functional Specification |
| Version | 1.1 (draft, awaiting approval) |
| Date | 2026-11-23 |
| Market | India — GST tax regime, INR pricing, Indian address, phone and numbering formats |
| Scope | Authentication, admin module, customer module, catalog skeleton, yellow/black theme |
| Repository | `akashkarthi11/matbyus`, branch `claude-dev` |
| Supersedes | — |

---

## 1. Purpose

matbyus sells construction **materials** and construction **services** to **business** buyers
(contractors, builders, dealers) and **individual** buyers (homeowners, self-builders).

It operates **in India**. That is a functional constraint, not a cosmetic one: prices are in INR,
tax is GST, materials carry HSN codes and services carry SAC codes, and a registered business buyer
needs a compliant tax invoice bearing their GSTIN to claim input tax credit. For a contractor, ITC
is the difference between the quoted price and the real cost, so GSTIN capture is not an optional
profile field — it is the reason a business account exists.

Phase 1 delivers the parts every later phase depends on: a way to be an account, a way to be the
right *kind* of account, and a catalog both kinds of buyer can browse. It deliberately stops short
of a cart. Nothing can be ordered in Phase 1.

The authentication design is **ported from the Wealth application**, which already runs this exact
pattern in production: scrypt password hashing, a stateless HMAC-signed session cookie, a
`session_version` column for revoking sessions, and per-email and per-IP rate limiting. Section 11
records where matbyus deliberately diverges from Wealth, and why.

## 2. In scope / out of scope

**In scope**

- Customer self-registration, sign in, sign out, session handling
- Two roles — `admin` and `customer` — each landing in its own module
- Two account types — `individual` and `business` — with a business verification queue
- Admin module: customer list, business approvals, product and category management, password reset
- Customer module: profile, catalog browse and filter, product detail
- Catalog covering both materials and services, including retail and business pricing
- Yellow/black visual theme with stated contrast guarantees

**Out of scope (Phase 2 and later)**

Cart, checkout, payment, orders, invoicing, delivery scheduling, quote negotiation for `quote`-priced
services, product images and media, search ranking, reviews, wishlists, email verification,
self-service password reset by email, multi-user business accounts, credit terms, returns.

## 3. Settled decisions and remaining assumptions

### 3.1 Settled — India

| # | Decision |
|---|---|
| C1 | Market is India. Tax is GST. Currency is INR, displayed as `₹` with Indian digit grouping (`₹1,24,500.00`, not `₹124,500.00`). |
| C2 | Materials carry an HSN code, services carry a SAC code, each with its own GST rate held per product. |
| C3 | Catalog prices are stored **exclusive of GST**. Tax-inclusive figures are computed for display, never stored. See FR-12. |
| C4 | A business account captures a GSTIN. Format and checksum are validated; the GSTIN is not checked against the GSTN portal in Phase 1. |
| C5 | Addresses are Indian: line 1, line 2, city, state (from the GST state list), 6-digit PIN code. |
| C6 | Phone numbers are Indian mobiles — 10 digits beginning 6–9, stored as `+91XXXXXXXXXX`. |
| C7 | Times are stored in UTC and displayed in IST (Asia/Kolkata). Dates display as `DD/MM/YYYY`. |
| C8 | The interface is English in Phase 1. Regional languages are a later phase, and no string is hard-coded in a way that blocks one. |
| C9 | Mobile-first. The majority of Indian ecommerce traffic is on phones; phone layout is the design target and desktop is the widening, not the reverse. |

### 3.2 Remaining assumptions

Each is cheap to change now and expensive to change after Phase 2.
**A1, A2 and A4 should be confirmed before build starts.**

| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | The seller is registered in **one** state and ships from **one** place of supply, held as configuration. | Multiple warehouses make place of supply per-shipment, which changes the GST split and the order schema. |
| A2 | GST rates are held per product and set by an admin, not derived from a built-in HSN rate table. | A built-in table would need maintaining against statutory changes; per-product keeps the owner's CA in control. Confirm this is acceptable. |
| A3 | A business account is one login. Multiple buyers per company is a later phase. | Multi-user accounts need an organisations table; account type would move to the organisation. |
| A4 | Business buyers see a separate, lower price once approved. Approval is manual, by an admin. | If pricing is negotiated per customer rather than a single business tier, a price-list table is needed instead of a second price column. |
| A5 | Services are sold either at a fixed price per unit of work, or as "request a quote". Quote handling itself is Phase 2. | If every service is quote-only, `pricing_mode` collapses and the catalog UI changes. |
| A6 | GST registration is not required to buy. An unregistered contractor or homeowner buys without a GSTIN. | If GSTIN were mandatory, business registration would block on it rather than accepting it as optional. |

> **Tax rates are not law in this document.** Indicative GST rates for construction goods and
> services change by notification. Every rate is a per-product value set by the owner on their tax
> advisor's instruction. No rate is hard-coded anywhere in matbyus.

## 4. Actors

| Actor | Description | Reaches the system by |
|---|---|---|
| Visitor | Not signed in | Public catalog browse only |
| Customer — individual | Self-registered buyer, retail pricing | Customer module |
| Customer — business | Self-registered buyer who submitted business details; retail pricing until approved, business pricing after | Customer module |
| Admin | Operates the store | Admin module |

Role (`admin` / `customer`) and account type (`individual` / `business`) are **independent**. Role
decides what a user may do; account type decides how they buy. An admin is not a customer and does
not carry an account type.

## 5. Functional requirements

### FR-1 — Customer registration

1. A visitor registers with email, password, full name and mobile number. No invitation or shared
   key is required.
2. Email must be a valid address, unique, at most 254 characters, stored lower-cased and trimmed.
3. Mobile must be a valid Indian mobile — 10 digits beginning 6–9 — stored as `+91XXXXXXXXXX`.
   Entries typed with `+91`, `0` or spaces are normalised rather than rejected.
4. A password must not be empty and must be at most 200 characters. **There is no minimum length**
   — see L9. The maximum is enforced on the server, not only in the browser.
5. A new account is always `role = customer`. **Registration can never create an admin.**
6. The registrant chooses individual or business.
   - Individual: the account is immediately usable.
   - Business: the account is immediately usable **at retail pricing**, and the business details
     (legal name, GSTIN, PAN, contact person, Indian address) enter the approval queue as `pending`.
7. On success the customer is signed in and lands in the customer module.
8. A duplicate email returns a clear error and does not reveal whether the existing account is a
   business account or an admin.

### FR-2 — Sign in

1. Email and password. On success a session cookie is issued and the user lands in the module for
   their role.
2. A wrong email and a wrong password return the **same** message — "Email or password is
   incorrect." — and the same HTTP status. Sign-in must not reveal whether an email is registered.
3. Rate limited: 5 failed attempts per email and 20 per IP in a rolling 15 minutes, after which
   sign-in returns 429 with a `Retry-After` header. A successful sign-in clears the email counter.
4. If the rate-limit store is unavailable, sign-in continues to work (fails open). Availability of
   the storefront outranks the rate limit.

### FR-3 — Session and sign out

1. A session lasts 7 days and is carried in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
2. The session identifies the user and the user's `session_version`. Raising that version in the
   database invalidates every session issued before it, immediately.
3. Sign out clears the cookie. It must work even when the session is already invalid or expired.
4. Every API that returns or changes customer data re-checks the session server-side. The browser is
   never trusted for identity or role.

### FR-4 — Password reset (Phase 1 limitation)

1. In Phase 1 a password is reset by a signed-in admin setting a new password for an account.
2. An anonymous reset attempt is refused, with guidance on how to get a reset.
3. Resetting a password raises that account's `session_version`, signing out every existing session
   for it. An admin resetting their own password has their current session re-issued, not dropped.
4. A locked-out admin is recovered with a command-line script run by the operator.
5. **This does not scale to public customers and is a known Phase 1 limitation** — see §10.
   Email-based self-service reset is the first item of Phase 2.

### FR-5 — Role-based modules

1. After sign in, `admin` lands in the admin module and `customer` in the customer module.
2. The navigation a user sees is derived from their role on the **server** and returned with the
   session. The browser renders what it is given; it does not decide.
3. A customer reaching an admin URL or calling an admin API is refused with 403, whatever the
   browser shows.
4. Hiding a menu is presentation. It is never the only thing stopping an action — every admin API
   independently verifies the caller's role.

### FR-6 — Business account verification

1. A business registration captures legal name, GSTIN, PAN, contact person and an Indian address
   (line 1, line 2, city, state from the GST state list, 6-digit PIN code).
2. GSTIN is validated for format **and checksum** before the registration is accepted: 15 characters,
   a 2-digit GST state code, a 10-character PAN, an entity code, `Z`, and a check character. A GSTIN
   whose embedded state code does not match the selected state is rejected with that reason.
3. GSTIN is optional (A6). An unregistered contractor may hold a business account without one, and
   is told plainly that no input tax credit can be passed on without it.
4. PAN, where given, is validated for format: five letters, four digits, one letter.
5. Status is one of `pending`, `approved`, `rejected`. Individual accounts carry `none`.
6. While `pending` or `rejected`, the customer browses and is quoted **retail** prices.
7. On `approved`, business pricing becomes visible immediately — no re-registration, no second account.
8. The customer can see their own status and the reason for a rejection, and can resubmit corrected
   details, which returns the account to `pending`.
9. Every status change records who changed it and when.

### FR-7 — Admin: customers

1. List customers with email, name, account type, business status and date joined.
2. Filter by account type and business status; search by email or name.
3. Open one customer to see their business details and status history.
4. Approve or reject a pending business account, with an optional note shown to the customer on rejection.
5. Reset a customer's password (FR-4).
6. An admin cannot delete a customer in Phase 1.

### FR-8 — Admin: catalog management

1. Create, edit, activate and deactivate products of both kinds — material and service.
2. A product carries SKU, name, URL slug, kind, category, summary, description, unit of sale,
   pricing mode, retail price, business price, minimum order quantity, HSN or SAC code, GST rate,
   and an active flag. Both prices are **exclusive of GST** (C3).
3. Materials additionally carry pack size, stock quantity and stock status.
4. Unit of sale comes from a fixed list covering how Indian construction supply is actually sold —
   `bag` (cement, 50 kg), `kg`, `quintal`, `tonne`, `brass` (100 cft of sand or aggregate), `cft`,
   `number` (bricks, blocks, fittings), `box` (tiles), `litre` (paint, chemicals), `bundle`,
   `sqft`, `rft`, and for services `per_sqft`, `per_day`, `per_visit`, `lumpsum`.
   An admin cannot invent a unit; adding one is a schema change, so quantities stay comparable.
5. A material must carry an HSN code and a service a SAC code before it can be activated. The code
   is free text with a length rule, not validated against a statutory list (A2).
6. Services carry neither stock nor pack size, and may be `quote` priced, in which case they have no price.
7. A `fixed`-priced product cannot be activated without a retail price.
8. A product cannot be activated without a category.
9. SKU and slug are unique across the catalog. Changing the slug of an active product is allowed but warned about.
10. Deactivating a product hides it from customers immediately. Products are never hard-deleted.
11. Manage categories: name, slug, kind, parent, sort order, active flag. A category holding active
    products cannot be deactivated.

### FR-9 — Customer: catalog browse

1. Browse all active products, filtered by kind (materials / services), by category, and by free-text
   search on name and summary.
2. Results are paginated and show name, category, unit of sale, price, and — for materials — stock status.
3. Prices shown follow FR-10.
4. Quote-priced services show "Request a quote" in place of a price. The request flow is Phase 2;
   Phase 1 shows the label only.
5. A visitor who is not signed in can browse, and sees retail prices.
6. Inactive products are invisible to customers and return 404 by slug, not an empty shell.

### FR-10 — Price visibility

1. Individual customers, visitors, and pending or rejected business accounts see the **retail** price.
2. Approved business accounts see the **business** price where one is set, labelled as the business
   price, with the retail price shown alongside it as the saving.
3. Where no business price is set, an approved business account sees the retail price.
4. Price selection happens on the **server**. A business price is never sent to a browser that is
   not entitled to see it.
5. Which price applies is decided here; how tax is shown on top of it is FR-12. The two rules are
   independent — an approved business sees the business price *and* the GST-exclusive presentation.

### FR-11 — Theme and accessibility

1. The interface uses a yellow-on-black construction theme across both modules.
2. Yellow is the action and emphasis colour; black and near-black are surfaces; white-ish grey is body text.
3. Every text/background pairing in the shipped palette meets WCAG 2.1 AA (4.5:1 for body text,
   3:1 for large text and interface boundaries). The specific pairings and their measured ratios are
   fixed in the TSD.
4. Yellow is never the only signal for a state. Errors, warnings and successes carry an icon or text
   label as well as a colour.
5. Interactive elements have a visible focus ring that is not yellow on yellow.
6. The layout is usable at phone width with no horizontal scrolling, including the admin tables.

### FR-12 — GST and tax presentation

1. Catalog prices are stored exclusive of GST (C3). Every figure shown to a customer is derived from
   that stored price and the product's GST rate.
2. **Individual customers and visitors see a GST-inclusive price** as the headline figure, with the
   tax component disclosed underneath ("₹1,24,500 incl. 18% GST"). Retail buyers in India expect
   the number they will pay.
3. **Approved business customers see the GST-exclusive price** as the headline figure, with the GST
   amount and the inclusive total shown beneath it. A contractor reclaims the tax, so the taxable
   value is the number that matters to them.
4. Pending and rejected business accounts are treated as retail for this rule, matching FR-10.
5. The GST rate and the HSN or SAC code are visible on the product detail page for every viewer.
6. Rounding is applied once, to the final displayed figure, at two decimal places, half-up.
   Intermediate values are never rounded.
7. Where the seller is not GST registered, or a product's rate is zero, the inclusive and exclusive
   figures are identical and no tax line is shown.
8. Phase 1 shows tax on prices. It does **not** issue invoices, split CGST/SGST/IGST, or determine
   place of supply — those belong to the order, which is Phase 2. The data needed for them (seller
   state, buyer state, HSN/SAC, rate) is captured in Phase 1 so Phase 2 does not need a migration
   of existing records.

### FR-13 — Indian formats and conventions

1. Money displays as `₹` with Indian digit grouping — `₹1,24,500.00`, never `₹124,500.00`.
2. Quantities display with their unit spelled the way the trade says it: "10 bags", "2 brass",
   "500 nos", "1.5 tonne".
3. Dates display as `DD/MM/YYYY` and times in IST, regardless of where the server runs.
4. Mobile numbers display as `+91 98765 43210`.
5. PIN code is 6 digits; the first digit is 1–8.
6. State is chosen from the GST state list, and the chosen state's code must agree with the first
   two digits of any GSTIN given (FR-6.2).
7. The interface is English. No user-facing string is embedded in a way that would prevent a
   regional-language pass later.
8. The layout is designed at phone width first (C9). Admin tables scroll within themselves rather
   than forcing the page sideways.

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Passwords are never stored or logged in a recoverable form, and never appear in an error message, log line or URL. |
| NFR-2 | No secret, token, session value or password reaches a log, an error response or the browser console. |
| NFR-3 | Every database write that changes an account's role, status or password records the actor and the time. |
| NFR-4 | A catalog list request answers in under 500 ms at p95 for a catalog of 5,000 products. |
| NFR-5 | The storefront stays readable and browsable when the rate-limit store is down. |
| NFR-6 | All API input is validated server-side. Nothing is trusted because the browser sent it. |
| NFR-7 | Every requirement here has at least one automated test before Phase 1 is called complete. |
| NFR-8 | Every page is usable at 360px width on a mid-range Android phone over a 3G connection. Mobile is the primary target, not a fallback (C9). |
| NFR-9 | Money is computed with exact decimal arithmetic, never IEEE floating point. A GST calculation must not produce a figure a customer can dispute by a paisa. |
| NFR-10 | A GSTIN, PAN or mobile number never appears in a log line, an error message or a URL. They are personal and commercial identifiers (see NFR-2). |

## 7. Error and edge behaviour

| Situation | Behaviour |
|---|---|
| Register with an existing email | 409, "An account with this email already exists." No hint about its role or type. |
| Register with a 6-character password | Accepted. There is no minimum length (L9). |
| Register with an empty password | 400, "Password is required." |
| Register with a 201-character password | 400, "Password is too long." |
| Sign in, unknown email | 401, "Email or password is incorrect." |
| Sign in, correct email, wrong password | 401, identical message and status to the line above. |
| 6th failed sign-in for one email inside 15 min | 429 with `Retry-After`. |
| Rate-limit store unreachable | Sign-in proceeds; the failure is logged without user detail. |
| Customer calls an admin API | 403, no data, logged with the caller id. |
| Session cookie tampered with | Treated as signed out. |
| Session valid but `session_version` raised | Treated as signed out. |
| Business account approved mid-session | Business pricing appears on the next page load; no re-login. |
| Activating a fixed-price product with no price | 400, names the missing field. |
| Deactivating a category holding active products | 400, lists the blocking products. |
| Customer opens an inactive product's URL | 404. |
| GSTIN fails the checksum | 400, "That GSTIN is not valid." The failing character is not named. |
| GSTIN state code disagrees with the chosen state | 400, names both so the customer can see which to correct. |
| Business registration with no GSTIN | Accepted (A6), with a notice that input tax credit cannot be passed on without one. |
| Mobile number typed as `098765 43210` or `+91-98765-43210` | Normalised to `+919876543210`, not rejected. |
| Mobile number of 9 digits, or beginning 1–5 | 400, states the rule. |
| PIN code not 6 digits, or starting 0 or 9 | 400, states the rule. |
| Activating a material with no HSN code | 400, names the missing field (FR-8.5). |
| Product with a zero GST rate | Inclusive and exclusive prices are equal; no tax line is rendered (FR-12.7). |

## 8. Acceptance criteria for Phase 1

1. A visitor registers as an individual, is signed in, and reaches the customer module.
2. A visitor registers as a business, is signed in, sees retail prices and a "verification pending" banner.
3. An admin approves that business; on the customer's next page load, business prices are shown.
4. An admin creates one material and one service; both appear to a customer; deactivating either removes it.
5. A customer calling any admin API receives 403.
6. Six failed sign-ins for one email produce a 429 with `Retry-After`.
7. An admin resets a customer's password; the customer's existing session stops working at once.
8. Every palette pairing in the TSD is verified against a contrast checker and the result recorded.
9. A business registration with a GSTIN whose checksum is wrong is refused; one with a valid GSTIN
   whose state code contradicts the chosen state is refused naming both; one with no GSTIN is accepted.
10. The same cement product shows a GST-inclusive headline price to an individual and a
    GST-exclusive headline price with the tax broken out to an approved business.
11. A price of 124500 renders as `₹1,24,500.00` — Indian grouping, not Western.
12. Every page is checked at 360px width with no horizontal scroll, including the admin customer table.
13. The full test suite passes, and every FR above maps to at least one test in the traceability matrix.

## 9. Phase 2 candidates (not authorised by this document)

Email verification and self-service password reset; **mobile OTP sign-in** (L6); cart and checkout;
**payments via UPI, net banking, cards and an Indian gateway such as Razorpay, PayU or Cashfree**;
cash on delivery; **GST tax invoices with the CGST/SGST/IGST split and place-of-supply logic**;
**e-way bill generation for consignments over the statutory threshold**, which construction material
loads routinely exceed; quote requests for `quote`-priced services; delivery scheduling and freight;
product images; multi-user business accounts; credit terms and TDS handling on works contracts;
regional-language interface.

## 10. Known limitations accepted for Phase 1

| # | Limitation | Why accepted | Must be fixed by |
|---|---|---|---|
| L1 | Password reset is admin-assisted, not self-service | No email provider is configured yet; adding one is a dependency and a cost decision for the owner | Before public launch |
| L2 | Email addresses are not verified | Same dependency as L1 | Before public launch |
| L3 | No cart or orders | Deliberate phase boundary | Phase 2 |
| L4 | Business pricing is one tier, not per-customer | A1/A4 assumption; a single tier covers the common case | When a negotiated price is first needed |
| L5 | Sessions cannot be listed or revoked individually, only all at once per user | Matches Wealth; stateless sessions keep the storefront fast | Only if a security review requires it |
| L6 | Sign-in is email and password. There is no mobile OTP | **Indian ecommerce convention is mobile + OTP**, and individual buyers in particular will expect it. It needs a paid SMS gateway and a DLT-registered sender, which is an owner decision. Porting the Wealth mechanism unchanged is the fastest route to a working Phase 1 | Before public launch to individual buyers; less urgent for a B2B-first launch |
| L7 | A GSTIN is validated for format and checksum, but not confirmed against the GSTN portal | Portal lookup needs a registered API and a per-call cost. Checksum validation already rejects typos and invented numbers | When a fraudulent GSTIN would cost real money — i.e. with credit terms |
| L8 | Phase 1 shows tax but issues no invoice and computes no CGST/SGST/IGST split | There is no order to invoice yet. The inputs are captured so Phase 2 needs no backfill | Phase 2, before the first real sale |
| L9 | **No minimum password length.** Any non-empty password of up to 200 characters is accepted, for customers and admins alike | Removed on the owner's explicit instruction, 2026-11-23, after the trade-off was put to them. It was a 10-character minimum | Owner's decision; see the risk note below |

### L9 — what the short-password decision rests on

Two things carry the weight that length no longer does, and **neither may be weakened without
revisiting this**:

1. **Rate limiting (FR-2.3).** Five failed sign-ins per email per 15 minutes, counted per email
   rather than per IP, so more IPs do not buy more guesses. A six-digit numeric password is one of
   a million; at 480 guesses a day it is not reachable by online guessing. This is the control.
2. **scrypt hashing (NFR-1).** If the database is ever disclosed, a six-digit password falls to an
   offline attack quickly whatever the hash, but scrypt makes it cost something rather than nothing.

The honest summary: online guessing is well defended; an offline attack against a leaked database
is not, and a short password cannot be made safe against one. The admin account is the one that
matters most, because it can approve businesses, edit the catalog and reset any customer's
password. If a password manager is ever in reach, a long admin password costs nothing and removes
this entry.

## 11. Deliberate divergences from the Wealth login

Wealth is a private, single-owner ledger. matbyus is a public storefront. The mechanism is copied;
four policies are not, and copying them unchanged would be a defect.

| # | Wealth | matbyus | Reason |
|---|---|---|---|
| V1 | Registration requires a shared access key | Registration is open | A storefront cannot ask buyers for a secret key. |
| V2 | Roles are `user` / `admin` | Roles are `customer` / `admin`, plus an independent `account_type` | A business buyer is still a customer; buying mode is not a permission. |
| V3 | An admin picks which menus the `user` role sees | Menus are fixed per role in Phase 1 | Storefront navigation is product-driven, not configurable per deployment. |
| V4 | Admin-only password reset is the final design | Admin-only reset is a temporary limitation (L1) | Wealth has one owner. A storefront with public customers will generate constant lockouts. |
| V5 | No phone number is captured | Indian mobile is required at registration | Deliveries are coordinated by phone in this trade, and the number is the identifier mobile OTP sign-in (L6) will later use. Capturing it now avoids asking every existing customer later. |

Everything else — scrypt hashing, the signed stateless cookie, `session_version` revocation, the
rate-limit shape and its fail-open behaviour, identical sign-in error messages — is copied
deliberately and without change, because it is already proven in production.
