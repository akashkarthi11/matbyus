# Reference data lives in the database

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |
| Migration | [`0005_lookups.sql`](../scripts/migrations/0005_lookups.sql) |
| Reader | [`api/_lookups.js`](../api/_lookups.js) |
| Served to the browser by | [`api/meta.js`](../api/meta.js) → `GET /api/meta` |

---

## The problem this removes

Until 2026-11-24 the roles, the menus, the GST state list, the unit list and the order status
machine were JavaScript constants. That had three costs, and the third is the one that bites:

1. Adding a unit meant a deploy. So did adding a state, a stock status, or a GST rate.
2. The product form's dropdown and the API's validation were **two copies of the same list**. They
   agreed because someone remembered, not because anything made them agree.
3. The order status machine existed twice — `MOVES` in `api/admin.js` and `ORDER_FLOW` in `app.js`.
   A button could offer a move the API would refuse, or the API could accept one no screen drew.

Now every one of those is a row, the API validates against the rows, and the browser is served the
same rows. There is no second copy to drift.

## Where the line falls

Not everything that looks like a list is reference data, and pretending otherwise would be worse
than leaving it alone. Three categories:

### Reference data the business edits → a table, and a foreign key

| Table | What it holds | What now references it |
|---|---|---|
| `mb_roles` | `customer`, `owner`, `admin` — label, singular label, home screen, whether an admin may tailor its menus | `mb_users.role`, `mb_role_menus.role` |
| `mb_menus` | Which screens each role has, their order, and which are always on | read by `menusForRole()` |
| `mb_units` | bag, tonne, brass, per sq ft … with singular, plural and which kind of product may use it | `mb_products.unit` |
| `mb_states` | The 39 GST state codes | `mb_business_profiles.state_code`, `mb_orders.place_of_supply_state`, `mb_orders.seller_state_code` |
| `mb_order_statuses` | placed → confirmed → dispatched → collected, plus cancelled; label, seller label, pill tone | `mb_orders.status` |
| `mb_order_transitions` | Which actor may make which move, from which state, and what the button says | the only source for both the API and the screen |

Adding a unit is an `INSERT`. A test proves exactly that: *"a unit added as a row is usable
immediately, with no deploy"* creates a listing in `tipper` units, gets a 400, inserts the row,
and gets a 201 — then checks `/api/meta` offers it and the catalogue labels it.

### Row-shape rules → they stay as CHECK constraints

A foreign key cannot say that a service carries no stock, that a quote carries no price, or that
CGST and SGST add up to the tax. Those are the shape of a legal row, not a list, and they stay in
the schema where they were.

One of them had to change form. "A service is not sold per bag" used to be a CHECK listing units by
name; it is now a rule about `mb_units.applies_to`, which a CHECK cannot read. It became a trigger,
`mb_products_unit_kind`. The invariant is still in the database — which is the point, because no
handler has to remember it — but it is worth knowing it moved.

### Small enums → their CHECK stays, their labels move

`account_type`, `business_status`, `owner_status`, `product_kind`, `pricing_mode`, `stock_status`,
`collection_method` and `tax_split` keep their CHECK constraints. The code *branches* on these
values, so a new one needs code either way and a foreign key would buy nothing. What does not belong
in code is how they are **spelled and ordered on screen** — and that is what moved, into
`mb_lookups (domain, code, label, sort_order, meta)`.

`mb_lookups` also carries `gst_rate`: the rates the product form offers. Not a constraint — the
column is a number held between 0 and 100 — but the list a form offers is reference data.

## How it is read

`api/_lookups.js` reads all six tables in **one query** and holds the result for a minute, keyed by
the database handle (a `WeakMap`, so a test's throwaway database never answers for another one and
production gets one entry per cold start).

Seven separate `SELECT`s was the obvious shape and the wrong one: it put seven queries in front of
the public catalogue, the endpoint this project has already paid once to get down to a single round
trip. One query also means one error when the tables are missing, instead of seven concurrent
failures — which, in PGlite, crashed the process.

A test pins the cost: the public catalogue makes **two** queries cold (lookups, then products) and
**one** warm, and never looks up the session.

### There is no fallback list

If the lookup tables are absent or empty, `lookups()` throws a `CONFIG` error and every handler
turns that into a **503 naming the problem**. It does not fall back to a hardcoded copy.

That is deliberate. A standby list would make a half-migrated deployment look healthy while
validating against a list the database does not share — the exact failure this change exists to
remove. Two tests hold the line: one on an unmigrated database, one on an emptied table.

The single exception is `mb_role_menus`, the *saved choice* of which menus to show. If that table is
missing, the full menu is served, because the menu is presentation and every API still refuses what
the caller may not do. The catalogue of menus is required; the override is optional.

## What the caller gets

```js
const lk = await lookups(db);

lk.roleCodes                  // ['admin', 'owner', 'customer']
lk.isConfigurable('admin')    // false — from mb_roles, not a constant
lk.homeView('owner')          // 'storeorders'
lk.menus.owner                // [{ key, label, icon }, ...]
lk.alwaysOn.owner             // ['storeorders', 'account']

lk.unitAllowedFor('bag', 'service')   // false
lk.formatQuantity(500, 'number')      // '500 nos'
lk.stateName('33')                    // 'Tamil Nadu'
lk.validStateCode('7')                // false — codes are two characters

lk.move('seller', 'collect')          // { action, to: 'collected', from: ['confirmed','dispatched'] }
lk.move('customer', 'confirm')        // null — a customer cannot accept their own order
lk.flowFor('seller', 'placed')        // the buttons, with labels and which is primary

lk.label('stock_status', 'out_of_stock')   // 'Out of stock'
lk.meta('stock_status', 'out_of_stock')    // { tone: 'out' }
```

`GET /api/meta` serves the browser the same thing, cached a minute at the browser and a day at the
edge. It carries nothing about who is asking, so it is safe to cache. The front end holds no list of
its own: `metaLabel()`, `statusInfo()`, `sellerMoves()` and `roleLabelOne()` in `app.js` are all
views on that one response.

## One guard worth knowing about

An action must land on one status. `collect` arrives from both `confirmed` and `dispatched`, but
both rows say `collected`. If two rows for one action ever disagreed, the handler's
single-destination `UPDATE` would silently pick one — so `_lookups.js` refuses to build and reports
`the seller action "x" leads to both y and z`.

## What this does not cover

- **Categories** were already a table (`mb_categories`) and are unchanged.
- **GST rates per product** were always a column. Only the *list the form offers* moved.
- **HSN and SAC codes** are per product and not a closed list; nothing here changes that.
- **The view names** (`materials`, `storeorders`, `account`) are routes in `app.js`. `mb_menus.key`
  names them, so adding a menu row for a screen that does not exist gives a dead tab. Menus are
  configuration; screens are code.
