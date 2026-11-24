# FSD — matbyus Phase 3: AI assistance

| | |
|---|---|
| Document | Functional Specification |
| Version | 1.0 |
| Date | 2026-11-24 |
| Builds on | Phase 1 and Phase 2 — both built and live |
| Provider | Anthropic Claude, through the official SDK `@anthropic-ai/sdk` |
| Design | [TSD Phase 3](TSD-phase-3-ai.md) |

---

## 1. What this phase adds, and what it deliberately does not

Five places where a model saves a real person real effort, each chosen because the alternative today
is either a form a small seller cannot fill in, or arithmetic a homeowner cannot do.

| # | Feature | Who | Replaces |
|---|---|---|---|
| AI-1 | **Draft a listing from plain words** | Owner, admin | A twelve-field form with HSN codes and GST rates most sellers do not know |
| AI-2 | **Search in plain words** | Everyone, signed out too | Knowing which category a "12 mm saria" lives under |
| AI-3 | **Plan my materials** | Customer, owner | Guessing how many bags of cement a 1,000 sq ft house takes |
| AI-4 | **Translate a message** | Customer, owner | A buyer in Madurai and a seller in Pune with no common language |
| AI-5 | **Advise on an offer** | Owner | Deciding a counter-price under time pressure |

Three rules hold for every one of them, and they are the reason this phase is safe to ship:

1. **The model suggests; a person decides.** Nothing the model returns is written to a listing, an
   order, a bid or a basket without a person pressing a button. A drafted listing prefills a form; an
   estimate prefills a basket; advice is a sentence next to the Counter button.
2. **The model never sets a price that is charged.** Every rupee on an order still comes from
   `priceLine()` and the database (D-26). An estimate's totals are computed by the server from the
   live catalogue, not by the model. Advice on an offer is a suggestion the owner types or ignores.
3. **The model never invents a product.** Search results are real catalogue rows the normal query
   returned. An estimate may only name products that exist and are live; anything else it returns is
   dropped before the customer sees it.

Out of scope for Phase 3: a chatbot; the model acting on anyone's behalf; images or PDFs; reading
another person's data on anyone's behalf; automatic translation of every message (translation is on
request, per message); the model seeing a conversation an admin cannot see.

## 2. Functional requirements

### AI-1 — Draft a listing from plain words

1. On the product form, an owner or admin can type a description the way they would say it — *"Ultratech
   OPC 53 cement 50 kg bag, 420 rupees, minimum 10 bags"* — and ask for a draft.
2. The draft fills: name, kind, category, unit, pack size, summary, description, pricing mode, retail
   price, HSN/SAC code and GST rate. Fields the description does not support are left empty, not guessed.
3. Category, unit, GST rate, kind and pricing mode can only be values that exist in the lookup tables.
   A unit that does not belong to the kind is dropped with a note (the same rule the database enforces).
4. The draft always carries a note that **GST rate and HSN/SAC must be confirmed with a tax adviser**.
5. Nothing is saved. The draft prefills the form; the owner edits and saves it as they would by hand,
   and every existing validation applies.

### AI-2 — Search in plain words

1. Beside the catalogue search box, a shopper can ask in plain words — *"cheap cement for roof slab"*,
   *"12mm saria"*, *"someone to plaster my walls"*.
2. The query is turned into the catalogue's own filters (kind, category, keywords), with one sentence
   saying how it was read. The results are then the normal catalogue query — real rows, real prices.
3. Open to visitors, so it is limited per visitor per day and in total per day.

### AI-3 — Plan my materials

1. A signed-in customer describes a project — *"2BHK ground floor house, 1,000 sq ft, brick walls,
   Chennai"* — and gets a list of catalogue items with a quantity and a one-line reason each.
2. The assumptions made (area, floors, wall type, mix) are shown first, so the customer can check them.
3. Quantities are rounded up to each item's minimum order. Prices and the total are the server's own,
   from the live catalogue at the customer's entitled price (trade or retail).
4. One button adds every line to the basket; the basket and checkout work exactly as before.
5. The screen says plainly that this is an estimate to start a conversation with a supplier, not an
   engineer's bill of quantities, and lists what an engineer should confirm.

### AI-4 — Translate a message

1. Under any message in a conversation they are part of, a customer or owner can ask for it in another
   language: English, Hindi, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati.
2. Product names, brands, numbers, units and prices are kept exactly as written.
3. Only a participant can translate a message; anyone else gets 404, as for reading it (NFR-21).
   An admin cannot — the same rule that keeps them out of conversations (FSD Phase 2 L1).
4. The translation is shown to the person who asked. It is not stored and the other side is not told.

### AI-5 — Advise on an offer

1. On an offer addressed to them, when it is their turn, an owner can ask for advice.
2. The advice is accept, counter or decline, a suggested counter-price when countering, and two or
   three sentences of reasoning.
3. The model is given the listing's prices, the offer's history, and the owner's own past sales of
   that item — nothing about the customer beyond what they offered.
4. The advice changes nothing. The owner still presses Accept, Counter or Decline.

### AI-6 — Settings and spend (admin)

1. An admin sees each AI feature with: on/off, model, effort, per-person daily limit, platform daily
   limit, and the instructions given to the model — and can change any of them. **All of it lives in
   the database, not the code** (the rule set in Phase 2 for every lookup).
2. An admin sees usage per feature for the last 7 days: calls, tokens, refusals, errors, and an
   estimated cost from the model's listed price.
3. Switching a feature off removes its button everywhere at once and its endpoint returns 503.

## 3. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-30 | **No personal data to the model.** No name, email, phone, address, GSTIN or PAN is sent. Translation sends the message text the participant asked about; nothing else from the conversation. |
| NFR-31 | **No prompt or response content in a log or a table.** Usage records feature, tokens, status, model and time — never what was asked or answered (extends NFR-24). |
| NFR-32 | **Every call is bounded**: a timeout inside the function's own time limit, one retry, and per-person and platform daily limits read from the database. |
| NFR-33 | **The app works with AI off.** No AI key, a feature switched off, a limit reached, a refusal or an outage each leave every non-AI path working, and say so in a sentence. |
| NFR-34 | **User text is data, not instructions.** Descriptions, queries and messages are passed to the model as quoted data; the model's output is constrained to a schema and validated against the database before anyone sees it. |
| NFR-35 | **Tests never call the model.** The client is injected; every behaviour is tested against a fake. |

## 4. Settled decisions

| # | Decision |
|---|---|
| C10 | **Claude, through the official SDK.** One provider, the official client, no OpenAI-compatible shim. |
| C11 | **Default model `claude-opus-5-5` for every feature**, with effort set per feature (low for extraction, search and translation; medium for planning and advice). Choosing a cheaper model for a feature is a cost decision for the owner of the platform, made in AI settings — not a decision the code makes. |
| C12 | **Structured outputs for every feature.** The model answers in a JSON schema; enums come from the lookup tables. |
| C13 | **Server-side refusal fallbacks on** for models that support them, so a safety decline on one model is retried on another inside the same call. |
| C14 | **Suggest, never act.** No AI output is persisted as a listing, order, bid, basket line or message. |

## 5. Known limitations accepted for Phase 3

| # | Limitation | Why |
|---|---|---|
| L10 | An estimate is thumb-rule arithmetic, not engineering | It starts a conversation with a supplier; the screen says so and lists what to confirm |
| L11 | GST and HSN suggestions can be wrong | Every draft says to confirm them; the seller saves the final values themselves |
| L12 | Translation of trade slang can be imperfect | Numbers, units and brand names are preserved; the original stays visible above it |
| L13 | The live AI path cannot run until `ANTHROPIC_API_KEY` is set on the deployment | Until then each AI endpoint returns 503 naming the missing setting, and nothing else is affected |
