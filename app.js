// matbyus storefront. One module, no framework (D-1).
// The server decides identity, role and price; this file renders what it is given (FR-5.2, FR-10.4).

import { iconEl, navIconEl } from '/icons.js';
import { qrSvg } from '/qr.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  return n;
};
const esc = s => String(s ?? '');

const state = {
  user: null, meta: null, view: null, items: [],
  filters: { kind: 'material', q: '', category: '' }, categories: [],
  basket: [], unreadNotifications: 0,
};

async function api(path, options = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error || `Request failed (${r.status})`);
    e.status = r.status; e.data = d;
    throw e;
  }
  return d;
}

// --- client cache -----------------------------------------------------------
// Stale-while-revalidate in the browser. A repeat view paints from the last response immediately
// and refreshes underneath, so moving between Materials and Services costs nothing visually even
// though the network is still doing its work.
//
// Only GETs that are safe to show briefly stale go through here, and the key carries the viewer's
// pricing mode: a cached retail list must never be shown to an approved business, or they would
// see retail prices from their own browser cache after everything the server does to prevent it.
// --- reference data ---------------------------------------------------------
// Every list on this screen comes from /api/meta, which reads the lookup tables (migration 0005).
// Nothing below keeps its own copy of a list the database already holds: a status label, a stock
// label, the GST rates a form offers and the buttons on an order are all rows, and the API
// validates against the same rows. Two copies of a list are two lists, eventually.

const metaRows = domain => state.meta?.lookups?.[domain] || [];
const metaOne = (domain, code) => metaRows(domain).find(x => x.code === String(code ?? '')) || null;
const metaLabel = (domain, code) => metaOne(domain, code)?.label ?? String(code ?? '');
const metaTone = (domain, code) => metaOne(domain, code)?.meta?.tone || '';

const statusInfo = code =>
  (state.meta?.orderStatuses || []).find(x => x.code === code) || { code, label: code, tone: 'plain' };
const sellerMoves = status => state.meta?.orderFlow?.[status] || [];
const customerMoves = status => state.meta?.customerFlow?.[status] || [];

const roleRow = code => (state.meta?.roles || []).find(r => r.code === code) || null;
const roleLabelOne = code => roleRow(code)?.labelOne || String(code ?? '');

// Where a sign-in lands, from mb_roles.home_view rather than a branch on the role name.
const homeView = () => roleRow(state.user?.role)?.home || 'materials';

const TTL = 60_000;
const viewerKey = () => (state.user ? `${state.user.role}:${state.user.accountType}:${state.user.businessStatus}` : 'anon');

function cacheGet(path) {
  try {
    const raw = sessionStorage.getItem('mb:' + viewerKey() + ':' + path);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw);
    return { data, fresh: Date.now() - at < TTL };
  } catch { return null; }
}

function cacheSet(path, data) {
  try {
    sessionStorage.setItem('mb:' + viewerKey() + ':' + path, JSON.stringify({ at: Date.now(), data }));
  } catch { /* private mode, or full - the page works without it */ }
}

export function cacheClear() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('mb:')) sessionStorage.removeItem(k);
  } catch { /* nothing to clear */ }
}

// Calls `render` with cached data at once when there is any, then again with the fresh response.
async function swr(path, render) {
  const hit = cacheGet(path);
  if (hit) render(hit.data, true);
  if (hit?.fresh) return hit.data;
  const data = await api(path);
  cacheSet(path, data);
  render(data, false);
  return data;
}

function skeletonGrid(n = 8) {
  const grid = el('div', { className: 'grid' });
  for (let i = 0; i < n; i++) {
    grid.append(el('div', { className: 'sk' },
      el('div', { className: 'sk-thumb' }),
      el('div', { className: 'sk-body' },
        el('div', { className: 'sk-line w40' }),
        el('div', { className: 'sk-line w80' }),
        el('div', { className: 'sk-line w60' }))));
  }
  return grid;
}

function banner(text, kind) {
  const b = $('banner');
  if (!text) { b.hidden = true; b.textContent = ''; return; }
  b.hidden = false;
  b.className = 'banner' + (kind ? ' is-' + kind : '');
  b.textContent = text;
}

function message(parent, text, kind = 'err') {
  parent.querySelectorAll('.msg').forEach(m => m.remove());
  if (!text) return;
  parent.append(el('div', { className: 'msg ' + kind, textContent: text }));
}

// --- shell ------------------------------------------------------------------

function renderShell() {
  const nav = $('nav'), session = $('session'), tabbar = $('tabbar');
  nav.textContent = ''; session.textContent = ''; tabbar.textContent = '';

  const menus = state.user ? state.user.menus : [
    { key: 'materials', label: 'Materials' }, { key: 'services', label: 'Services' },
  ];

  // The same menu, rendered twice: words in the header for a wide screen, icons in the bottom bar
  // for a phone. CSS decides which is visible, so there is one source of truth for what exists.
  for (const m of menus) {
    const b = el('button', { type: 'button', textContent: m.label });
    if (state.view === m.key) b.setAttribute('aria-current', 'page');
    b.onclick = () => go(m.key);
    nav.append(b);
  }

  // Following the Wealth app: a few primary tabs, then More, which opens a full page of grouped
  // rows. Five squeezed icons is worse than four and a door to the rest — the labels stop fitting
  // and nothing gets a description.
  const primary = menus.slice(0, 3);
  const tabs = [...primary];
  if (!state.user) tabs.push({ key: 'auth', label: 'Sign in' });
  tabs.push({ key: 'more', label: 'More' });

  for (const m of tabs) {
    const b = el('button', { type: 'button', 'aria-label': m.label },
      navIconEl(m.key), el('span', { textContent: m.label }));
    if (state.view === m.key || (m.key === 'more' && !primary.some(p => p.key === state.view) && state.view !== 'auth')) {
      b.setAttribute('aria-current', 'page');
    }
    if (m.key === 'more' && state.pendingApprovals > 0) {
      b.append(el('span', { className: 'nav-badge', textContent: String(state.pendingApprovals) }));
    }
    b.onclick = () => go(m.key);
    tabbar.append(b);
  }

  if (state.user) {
    // Negotiation and the basket are customer/owner concerns; an admin runs the platform and buys
    // nothing, so neither icon clutters their header.
    if (state.user.role !== 'admin') {
      const bell = el('button', {
        type: 'button', className: 'icon-btn', 'aria-label': 'Notifications',
      }, navIconEl('bell'));
      if (state.unreadNotifications > 0) {
        bell.append(el('span', { className: 'nav-badge', textContent: String(state.unreadNotifications) }));
      }
      bell.onclick = () => go('notifications');
      session.append(bell);

      const cart = el('button', {
        type: 'button', className: 'icon-btn', 'aria-label': 'Basket',
      }, navIconEl('basket'));
      if (state.basket.length) {
        cart.append(el('span', { className: 'nav-badge', textContent: String(state.basket.length) }));
      }
      cart.onclick = () => go('basket');
      session.append(cart);
    }

    session.append(el('span', { className: 'who', textContent: state.user.email }));
    const out = el('button', { type: 'button', className: 'ghost', textContent: 'Sign out' });
    out.onclick = async () => {
      await api('/api/auth?action=logout', { method: 'POST', body: '{}' });
      state.user = null;
      cacheClear();          // the cached lists belonged to the signed-in viewer
      go('materials');
      banner('Signed out.', 'good');
    };
    session.append(out);
  } else {
    const inb = el('button', { type: 'button', className: 'primary', textContent: 'Sign in' });
    inb.onclick = () => go('auth');
    session.append(inb);
  }
}

// --- routing ----------------------------------------------------------------
// Each view gets a URL. Without this the Android back button leaves the site instead of going
// back a screen, which is the first thing anyone does on a phone, and no screen can be linked to.

function go(view, opts = {}) {
  // A screen that switched the camera on has to switch it off when it is left, including by the
  // Android back button. Without this the indicator light stays on after the page has gone.
  if (state.cleanup) { try { state.cleanup(); } catch {} state.cleanup = null; }
  if (!opts.fromHistory) {
    const want = '#/' + view;
    if (location.hash !== want) history.pushState(null, '', want);
  }
  state.view = view;
  renderShell();
  const v = $('view');
  v.textContent = '';
  $('main').focus({ preventScroll: true });
  const draw = {
    auth: renderAuth, materials: () => renderCatalog('material'), services: () => renderCatalog('service'),
    account: renderAccount, dashboard: renderDashboard, products: renderAdminProducts,
    categories: renderAdminCategories, customers: renderAdminCustomers, approvals: renderApprovals,
    more: renderMore, orders: renderOrders, storeorders: renderStoreOrders, permissions: renderPermissions,
    owners: renderOwners, basket: renderBasket, messages: renderMessages, bids: renderBids,
    notifications: renderNotifications,
  }[view] || (() => renderCatalog('material'));
  draw(v);
}

// --- auth (FR-1, FR-2) ------------------------------------------------------

function renderAuth(v) {
  let mode = 'login';
  let accountType = 'individual';

  const wrap = el('div', { className: 'auth card' });
  const title = el('h1', { textContent: 'Sign in' });
  const lede = el('p', { className: 'lede' });
  const tabs = el('div', { className: 'tabs', role: 'tablist' });
  const form = el('form');
  wrap.append(title, lede, tabs, form);
  v.append(wrap);

  const tab = (key, label) => {
    const b = el('button', { type: 'button', role: 'tab', textContent: label });
    b.setAttribute('aria-selected', String(mode === key));
    b.onclick = () => { mode = key; draw(); };
    return b;
  };

  function draw() {
    tabs.textContent = '';
    tabs.append(tab('login', 'Sign in'), tab('register', 'Create account'));
    title.textContent = mode === 'login' ? 'Sign in' : 'Create your account';
    lede.textContent = mode === 'login'
      ? 'Buy construction materials and book site services.'
      : 'Contractors and homeowners welcome. Business accounts get trade pricing once verified.';

    form.textContent = '';
    form.append(field('email', 'Email', { type: 'email', autocomplete: 'email', required: true }));

    if (mode === 'register') {
      form.append(field('fullName', 'Full name', { autocomplete: 'name', required: true }));
      form.append(field('phone', 'Mobile number', {
        type: 'tel', autocomplete: 'tel', required: true, placeholder: '98765 43210',
      }, 'We use this to coordinate delivery.'));
    }

    form.append(field('password', 'Password', {
      type: 'password', required: true,
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
      placeholder: mode === 'register' ? 'At least 10 characters' : '',
    }));

    if (mode === 'register') {
      const seg = el('div', { className: 'seg' });
      for (const [key, label] of [['individual', 'Individual'], ['business', 'Business']]) {
        const b = el('button', { type: 'button', textContent: label });
        b.setAttribute('aria-pressed', String(accountType === key));
        b.onclick = () => { accountType = key; draw(); };
        seg.append(b);
      }
      form.append(el('label', {}, el('span', { textContent: 'Account type' })), seg);
      if (accountType === 'business') form.append(businessBlock());
    }

    const submit = el('button', {
      type: 'submit', className: 'primary',
      textContent: mode === 'login' ? 'Sign in' : 'Create account',
    });
    form.append(submit);

    if (mode === 'login') {
      const f = el('p', { className: 'small muted' }, 'Forgotten your password? ');
      const b = el('button', { type: 'button', className: 'link', textContent: 'How to reset it' });
      b.onclick = () => message(form,
        'Passwords are reset by the store team. Contact support and we will set a new one for you.', 'ok');
      f.append(b);
      form.append(f);
    }
  }

  function field(name, label, attrs = {}, hint) {
    const input = el('input', { name, id: 'f_' + name, ...attrs });
    const l = el('label', { htmlFor: 'f_' + name }, el('span', { textContent: label }), input);
    if (hint) l.append(el('small', { className: 'muted', textContent: hint }));
    return l;
  }

  function businessBlock() {
    const box = el('div', { className: 'card' });
    box.append(el('h2', { textContent: 'Business details' }));
    box.append(el('p', { className: 'small muted', textContent:
      'A verified business account sees trade prices. Without a GSTIN we cannot pass on input tax credit.' }));
    box.append(field('legalName', 'Business name', { required: true }));
    box.append(field('gstin', 'GSTIN (optional)', { placeholder: '27AAPFU0939F1ZV', maxLength: 15, style: 'text-transform:uppercase' }));
    box.append(field('pan', 'PAN (optional)', { placeholder: 'AAPFU0939F', maxLength: 10, style: 'text-transform:uppercase' }));

    const select = el('select', { name: 'stateCode', id: 'f_stateCode', required: true });
    select.append(el('option', { value: '', textContent: 'Select a state' }));
    for (const s of (state.meta?.states || [])) {
      select.append(el('option', { value: s.code, textContent: `${s.name} (${s.code})` }));
    }
    box.append(el('label', { htmlFor: 'f_stateCode' }, el('span', { textContent: 'State' }), select));

    box.append(field('addressLine1', 'Address', { required: true }));
    box.append(field('addressLine2', 'Address line 2 (optional)'));
    const row = el('div', { className: 'row two' });
    row.append(field('city', 'City', { required: true }), field('pincode', 'PIN code', { required: true, inputMode: 'numeric', maxLength: 7 }));
    box.append(row);
    box.append(field('contactPerson', 'Contact person (optional)'));
    return box;
  }

  form.onsubmit = async e => {
    e.preventDefault();
    message(form, '');
    const f = Object.fromEntries(new FormData(form).entries());
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      const payload = mode === 'login'
        ? { email: f.email, password: f.password }
        : {
            email: f.email, password: f.password, fullName: f.fullName, phone: f.phone, accountType,
            business: accountType === 'business' ? {
              legalName: f.legalName, gstin: f.gstin, pan: f.pan, stateCode: f.stateCode,
              addressLine1: f.addressLine1, addressLine2: f.addressLine2,
              city: f.city, pincode: f.pincode, contactPerson: f.contactPerson,
            } : undefined,
          };
      const d = await api('/api/auth?action=' + mode, { method: 'POST', body: JSON.stringify(payload) });
      cacheClear();          // pricing mode may differ from whatever was cached as a visitor
      state.user = d.user;
      afterSignIn();
    } catch (x) {
      message(form, x.message);
      submit.disabled = false;
    }
  };

  draw();
}

function afterSignIn() {
  const u = state.user;
  refreshNotifications().then(renderShell);
  // Anyone who is not a customer lands on the home screen their role names in mb_roles.
  if (u.role !== 'customer') {
    go(homeView());
    const what = roleLabelOne(u.role).toLowerCase();
    banner(`Signed in as ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}.`, 'good');
    return;
  }

  // Resume whatever they were doing when we interrupted them to sign in.
  const next = takeNext();
  if (next) {
    history.replaceState(null, '', next);
    if (routeFromHash(true)) { banner('Signed in. Carrying on where you left off.', 'good'); return; }
  }
  go('materials');
  if (u.accountType === 'business' && u.businessStatus === 'pending') {
    banner('Your business account is being verified. You are seeing retail prices until it is approved.');
  } else if (u.accountType === 'business' && u.businessStatus === 'rejected') {
    banner('Your business verification was not approved. Contact support, or update your details.', 'bad');
  } else if (u.accountType === 'business' && u.businessStatus === 'approved') {
    banner('Trade pricing is active on your account.', 'good');
  } else {
    banner('Signed in.', 'good');
  }
}

// --- the More hub -----------------------------------------------------------
// Modelled on the Wealth app's more-hub: a full page of grouped rows rather than a crowded menu.
// Each row is a large target carrying an icon, a title, a line saying what it is for, and a count
// where a count means something — so a first-time admin can tell what "Approvals" is without
// opening it.

function moreRow({ key, title, note, count, action, icon }) {
  const b = el('button', { type: 'button', className: 'more-link' },
    el('span', { className: 'more-link-icon' }, navIconEl(icon || key)),
    el('span', { className: 'more-link-copy' },
      el('b', { textContent: title }),
      el('small', { textContent: note })));
  if (count != null) b.append(el('span', { className: 'more-link-count', textContent: String(count) }));
  b.append(el('span', { className: 'more-link-arrow', textContent: '›' }));
  b.onclick = action || (() => go(key));
  return b;
}

function moreGroup(title, rows) {
  const s = el('section', { className: 'more-group' });
  s.append(el('h4', { textContent: title }));
  const list = el('div', { className: 'more-list' });
  for (const r of rows) list.append(moreRow(r));
  s.append(list);
  return s;
}

async function renderMore(v) {
  const hub = el('section', { className: 'more-hub' });
  hub.append(el('div', { className: 'more-welcome' },
    el('div', { className: 'eyebrow', textContent: 'QUICK ACCESS' }),
    el('h3', { textContent: 'Everything in one place' }),
    el('p', { className: 'muted', textContent:
      state.user?.role === 'admin' ? 'Run matbyus — owners, catalogue, customers and approvals.'
      : isOwner() ? 'Run your shop — your orders and your listings.'
      : 'Browse the catalogue and manage your account.' })));
  v.append(hub);

  if (isOwner()) {
    hub.append(moreGroup('SELLING', [
      { key: 'storeorders', icon: 'products', title: 'Orders received', note: 'Accept, dispatch and close out the orders placed with you' },
      { key: 'products', title: 'My listings', note: 'Add, price, put live or take offline' },
      { key: 'dashboard', title: 'My sales', note: 'Your listings and your orders at a glance' },
    ]));
    hub.append(moreGroup('SHOP', [
      { key: 'materials', title: 'Construction materials', note: 'See the catalogue as a customer does' },
      { key: 'services', title: 'Site services', note: 'Plastering, masonry and contracting' },
    ]));
  } else if (state.user?.role === 'admin') {
    const counts = { products: null, categories: null, customers: null, approvals: null };
    hub.append(moreGroup('PLATFORM', [
      { key: 'dashboard', title: 'Dashboard', note: 'Totals for matbyus at a glance' },
      { key: 'storeorders', icon: 'products', title: 'Orders received', note: 'Every order, across every owner' },
      { key: 'owners', icon: 'customers', title: 'Owners', note: 'Who sells here, what they sold, and who is asking to join' },
    ]));
    const catalogue = moreGroup('CATALOGUE', [
      { key: 'products', title: 'Products', note: 'Add, edit, put live or take offline' },
      { key: 'categories', title: 'Categories', note: 'How materials and services are grouped' },
    ]);
    hub.append(catalogue);
    const people = moreGroup('CUSTOMERS', [
      { key: 'customers', title: 'Customers', note: 'Everyone registered, and their account type' },
      { key: 'approvals', title: 'Business approvals', note: 'Verify a GSTIN and switch on trade pricing' },
    ]);
    hub.append(people);

    // fill the counts once they arrive, without holding up the page
    Promise.all([
      api('/api/admin?resource=products').then(d => d.products.length).catch(() => null),
      api('/api/admin?resource=categories').then(d => d.categories.length).catch(() => null),
      api('/api/admin?resource=customers').then(d => d.customers.length).catch(() => null),
      api('/api/admin?resource=approvals').then(d => d.approvals.length).catch(() => null),
    ]).then(([p, c, cu, a]) => {
      Object.assign(counts, { products: p, categories: c, customers: cu, approvals: a });
      const set = (root, i, n) => {
        if (n == null) return;
        const row = root.querySelectorAll('.more-link')[i];
        if (row) row.insertBefore(el('span', { className: 'more-link-count', textContent: String(n) }),
          row.querySelector('.more-link-arrow'));
      };
      set(catalogue, 0, p); set(catalogue, 1, c);
      set(people, 0, cu); set(people, 1, a);
      state.pendingApprovals = a || 0;
      if (a) renderShell();
    });
  } else {
    hub.append(moreGroup('SHOP', [
      { key: 'materials', title: 'Construction materials', note: 'Cement, steel, sand, bricks, finishes' },
      { key: 'services', title: 'Site services', note: 'Plastering, masonry and contracting' },
    ]));
  }

  const account = [];
  if (state.user) {
    if (state.user.role === 'customer') {
      account.push({ key: 'orders', icon: 'products', title: 'My orders', note: 'What you have ordered, and its status' });
    }
    account.push({ key: 'account', title: 'My account', note: state.user.email });
    account.push({
      key: 'signout', icon: 'auth', title: 'Sign out', note: 'End your session on this device',
      action: async () => {
        await api('/api/auth?action=logout', { method: 'POST', body: '{}' });
        state.user = null; state.pendingApprovals = 0; cacheClear();
        go('materials'); banner('Signed out.', 'good');
      },
    });
  } else {
    account.push({ key: 'auth', title: 'Sign in or create an account', note: 'Business accounts get trade pricing' });
  }
  hub.append(moreGroup('ACCOUNT', account));

  hub.append(el('div', { className: 'more-footnote', textContent: 'matbyus · prices in INR · GST shown on every item' }));
}

// --- catalog (FR-9, FR-10, FR-12) ------------------------------------------

async function renderCatalog(kind, v = $('view')) {
  if (state.filters.kind !== kind) state.filters.category = '';
  state.filters.kind = kind;

  const hero = el('div', { className: 'hero' });
  hero.append(el('h1', { textContent: kind === 'material' ? 'Construction materials' : 'Site services' }));
  hero.append(el('p', { textContent: kind === 'material'
    ? 'Cement, steel, aggregate, bricks and finishes — sold by the bag, brass, tonne or piece, delivered to site.'
    : 'Plastering, masonry and contracting. Priced per sq ft, per day, or quoted after a site visit.' }));

  const kinds = el('div', { className: 'kinds' });
  for (const [key, label] of [['material', 'Materials'], ['service', 'Services']]) {
    const b = el('button', { type: 'button', textContent: label });
    b.setAttribute('aria-pressed', String(kind === key));
    b.onclick = () => go(key === 'material' ? 'materials' : 'services');
    kinds.append(b);
  }
  hero.append(kinds);
  v.append(hero);

  const searchbar = el('div', { className: 'searchbar' });
  const q = el('input', { type: 'search', placeholder: 'Search cement, TMT, sand…', value: state.filters.q, 'aria-label': 'Search products' });
  const btn = el('button', { type: 'button', className: 'primary', textContent: 'Search' });
  searchbar.append(q, btn);
  v.append(searchbar);

  const chips = el('div', { className: 'chips' });
  v.append(chips);

  const results = el('div');
  v.append(results);

  const drawChips = cats => {
    chips.textContent = '';
    const all = el('button', { type: 'button', className: 'chip', textContent: 'All' });
    all.setAttribute('aria-pressed', String(!state.filters.category));
    all.onclick = () => { state.filters.category = ''; drawChips(cats); load(); };
    chips.append(all);
    for (const c of cats) {
      const b = el('button', { type: 'button', className: 'chip' },
        iconEl(c.slug, c.name), c.name,
        el('span', { className: 'n', textContent: String(c.products) }));
      b.setAttribute('aria-pressed', String(state.filters.category === c.slug));
      b.onclick = () => { state.filters.category = c.slug; drawChips(cats); load(); };
      chips.append(b);
    }
  };

  const draw = (d, stale) => {
    results.textContent = '';
    if (d.viewer?.businessPricing) {
      results.append(el('p', { className: 'small' },
        el('span', { className: 'pill yellow', textContent: 'Trade pricing' }),
        ' Prices exclude GST, which you reclaim as input tax credit.'));
    }
    if (!d.items.length) {
      results.append(el('p', { className: 'empty', textContent:
        state.filters.q ? `Nothing matches “${state.filters.q}”.` : 'Nothing listed here yet.' }));
      return;
    }
    const grid = el('div', { className: 'grid' });
    for (const item of d.items) grid.append(productCard(item));
    results.append(grid);
    results.append(el('p', { className: 'small muted', style: 'margin-top:14px',
      textContent: `${d.items.length} of ${d.total} product${d.total === 1 ? '' : 's'}${stale ? ' · refreshing' : ''}` }));
  };

  const load = async () => {
    const p = new URLSearchParams({ kind });
    if (state.filters.q) p.set('q', state.filters.q);
    if (state.filters.category) p.set('category', state.filters.category);
    // Only an approved business asks for the private trade view; everyone else takes the public,
    // edge-cached URL, which is why it comes back in tens of milliseconds on a repeat visit.
    if (state.user?.accountType === 'business' && state.user.businessStatus === 'approved') p.set('trade', '1');
    const path = '/api/catalog?' + p;
    if (!cacheGet(path)) { results.textContent = ''; results.append(skeletonGrid()); }
    try {
      await swr(path, draw);
    } catch (x) {
      results.textContent = '';
      message(results, x.message);
    }
  };

  btn.onclick = () => { state.filters.q = q.value.trim(); load(); };
  q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } };

  load();
  // One small, edge-cached request instead of pulling 100 products to discover the categories.
  swr('/api/categories?kind=' + kind, d => drawChips(d.categories)).catch(() => {});
}

function productCard(item) {
  const card = el('button', { type: 'button', className: 'product' });

  const thumb = el('div', { className: 'thumb' },
    iconEl(item.category?.slug, item.category?.name || item.name),
    el('span', { className: 'kindtag', textContent: metaLabel('product_kind', item.kind) }));
  card.append(thumb);

  const body = el('div', { className: 'pbody' });
  if (item.category) body.append(el('div', { className: 'cat', textContent: item.category.name }));
  body.append(el('div', { className: 'name', textContent: item.name }));
  if (item.summary) body.append(el('div', { className: 'sum', textContent: item.summary }));

  const meta = el('div', { className: 'per' });
  meta.append(`Per ${item.unitLabel}`);
  if (item.minOrderQty > 1) meta.append(` · min ${item.minOrderQty}`);
  body.append(meta);

  if (item.kind === 'material' && item.stockStatus) {
    const label = metaLabel('stock_status', item.stockStatus);
    const tone = metaTone('stock_status', item.stockStatus);
    const cls = tone ? ' ' + tone : '';
    body.append(el('div', {}, el('span', { className: 'pill' + cls, textContent: label })));
  }

  const price = el('div', { className: 'price' });
  price.append(el('div', { className: 'headline', textContent: item.price.headlineLabel }));
  if (item.price.taxLine) price.append(el('div', { className: 'taxline', textContent: item.price.taxLine }));
  if (item.price.mode === 'exclusive' && item.price.totalLabel) {
    price.append(el('div', { className: 'taxline', textContent: `${item.price.totalLabel} with GST` }));
  }
  if (item.price.compareAtLabel) {
    price.append(el('div', { className: 'compare', textContent: `Retail ${item.price.compareAtLabel}` }));
  }
  body.append(price);

  // FSD Phase 2 §4: a listing shows which owner sells it. Absent for a house listing.
  if (item.seller) body.append(el('div', { className: 'small muted', textContent: 'Sold by ' + item.seller.name }));

  // Buy and Add both sit on the card so the common case is one tap, not two. Neither should also
  // open the product, hence stopPropagation on both.
  const row = el('div', { className: 'card-actions' });
  if (item.pricingMode === 'fixed' && item.stockStatus !== 'out_of_stock') {
    const b = el('button', { type: 'button', className: 'primary buy-btn', textContent: 'Buy' });
    b.onclick = e => { e.stopPropagation(); buy(item.slug); };
    const add = el('button', { type: 'button', className: 'ghost buy-btn', 'aria-label': 'Add to basket', textContent: '+ Basket' });
    add.onclick = e => { e.stopPropagation(); basketAdd(item.slug, item.minOrderQty); banner(`${item.name} added to your basket.`, 'good'); };
    row.append(b, add);
  } else if (item.pricingMode === 'quote') {
    const b = el('button', { type: 'button', className: 'ghost buy-btn', textContent: 'Ask for a price' });
    b.onclick = e => { e.stopPropagation(); openProduct(item.slug); };
    row.append(b);
  }
  body.append(row);

  card.append(body);
  card.onclick = () => openProduct(item.slug);
  return card;
}

async function openProduct(slug, opts = {}) {
  if (!opts.fromHistory) {
    const want = '#/p/' + slug;
    if (location.hash !== want) history.pushState(null, '', want);
  }
  state.view = 'product';
  renderShell();
  const v = $('view');
  v.textContent = '';
  const back = el('button', { type: 'button', className: 'ghost', textContent: '← Back' });
  back.onclick = () => history.back();
  v.append(back);
  try {
    const trade = state.user?.accountType === 'business' && state.user.businessStatus === 'approved' ? '&trade=1' : '';
    const { product: p } = await api('/api/catalog?slug=' + encodeURIComponent(slug) + trade);
    const card = el('div', { className: 'card detail' });
    if (p.category) card.append(el('div', { className: 'cat small muted', textContent: p.category.name.toUpperCase() }));
    card.append(el('h1', { textContent: p.name }));
    if (p.summary) card.append(el('p', { className: 'muted', textContent: p.summary }));
    if (p.seller) card.append(el('p', { className: 'small muted', textContent: 'Sold by ' + p.seller.name }));
    card.append(el('div', { className: 'headline', textContent: p.price.headlineLabel }));
    if (p.price.taxLine) card.append(el('p', { className: 'small muted', textContent: p.price.taxLine }));
    if (p.price.mode === 'exclusive' && p.price.totalLabel) {
      card.append(el('p', { className: 'small muted', textContent: `${p.price.totalLabel} including GST` }));
    }
    if (p.description) card.append(el('p', { textContent: p.description }));

    const dl = el('dl');
    const add = (k, val) => { if (val != null && val !== '') dl.append(el('dt', { textContent: k }), el('dd', { textContent: String(val) })); };
    add('SKU', p.sku);
    add('Sold per', p.unitLabel);
    add('Minimum order', p.minOrderQty);
    if (p.kind === 'material') {
      add('Pack size', p.packSize);
      add('Availability', metaLabel('stock_status', p.stockStatus));
    }
    add(p.kind === 'service' ? 'SAC code' : 'HSN code', p.hsnSac);
    add('GST rate', p.gstRate + '%');
    card.append(dl);

    const actions = el('div', { className: 'form-actions' });
    if (p.pricingMode === 'fixed' && p.stockStatus !== 'out_of_stock') {
      const b = el('button', { type: 'button', className: 'primary', textContent: 'Buy this' });
      b.onclick = () => buy(p.slug);
      const add = el('button', { type: 'button', className: 'ghost', textContent: 'Add to basket' });
      add.onclick = () => { basketAdd(p.slug, p.minOrderQty); banner(`${p.name} added to your basket.`, 'good'); };
      actions.append(b, add);
    } else if (p.stockStatus === 'out_of_stock') {
      actions.append(el('p', { className: 'muted small', textContent: 'Out of stock. Ask the store when it is back.' }));
    } else {
      actions.append(el('p', { className: 'muted small', textContent: 'Priced on request. Contact the store for a quote.' }));
    }
    // FSD Phase 2 FR-23, FR-24: negotiation only exists where there is an owner to negotiate with.
    if (p.seller && state.user?.role !== 'admin') {
      const negotiate = el('button', { type: 'button', className: 'ghost', textContent: 'Ask for a better price' });
      negotiate.onclick = () => openBidForm(p.slug);
      const chat = el('button', { type: 'button', className: 'ghost', textContent: 'Message the seller' });
      chat.onclick = () => startConversation(p.slug);
      actions.append(negotiate, chat);
    }
    card.append(actions);
    v.append(card);
  } catch (x) {
    message(v, x.message);
  }
}

// --- buying -----------------------------------------------------------------

// Where the customer was heading when they were asked to sign in. Kept so that signing in resumes
// the purchase instead of dropping them on the front page, which is the moment most carts are lost.
const NEXT_KEY = 'mb:next';
const rememberNext = hash => { try { sessionStorage.setItem(NEXT_KEY, hash); } catch {} };
const takeNext = () => {
  try { const v = sessionStorage.getItem(NEXT_KEY); sessionStorage.removeItem(NEXT_KEY); return v; }
  catch { return null; }
};

// --- the basket ---------------------------------------------------------------
// A list of { slug, qty } only — never a price. The price is whatever the server quotes at
// checkout (D-26 extended to the basket, FR-25.4); storing one here would just be a second figure
// to go stale. sessionStorage, not state alone, so a reload or the Android back button does not
// quietly empty someone's basket (the same reasoning as the SWR cache, scoped per browser tab).
const BASKET_KEY = 'mb:basket';
function loadBasket() {
  try { return JSON.parse(sessionStorage.getItem(BASKET_KEY) || '[]'); } catch { return []; }
}
function saveBasket() {
  try { sessionStorage.setItem(BASKET_KEY, JSON.stringify(state.basket)); } catch {}
}
function basketAdd(slug, qty) {
  const line = state.basket.find(l => l.slug === slug);
  if (line) line.qty = Number(line.qty) + Number(qty);
  else state.basket.push({ slug, qty: Number(qty) });
  saveBasket();
  renderShell();
}
function basketRemove(slug) {
  state.basket = state.basket.filter(l => l.slug !== slug);
  saveBasket();
  renderShell();
}
function basketSetQty(slug, qty) {
  const line = state.basket.find(l => l.slug === slug);
  if (line) { line.qty = Number(qty); saveBasket(); }
}
function basketCount() { return state.basket.reduce((n, l) => n + 1, 0); }

// --- notifications --------------------------------------------------------------
// A badge, not a feed: the header only needs the unread count (FR-28.2). Refreshed after sign-in
// and after any action that creates one for this account (nothing polls, since there is no push
// channel in Phase 2 — see docs L4). A stale badge by a few minutes is the accepted cost.
async function refreshNotifications() {
  if (!state.user) { state.unreadNotifications = 0; return; }
  try {
    const d = await api('/api/notifications');
    state.unreadNotifications = d.unread;
  } catch { /* a transient failure just leaves the last-known badge showing */ }
}

// The Buy entry point. Signed out, it asks for a sign-in and comes straight back here afterwards.
function buy(slug) {
  if (!state.user) {
    rememberNext('#/buy/' + slug);
    go('auth');
    banner('Sign in to place this order — we will bring you straight back.');
    return;
  }
  openBuy(slug);
}

async function openBuy(slug, opts = {}) {
  if (!state.user) {                       // a shared or reloaded /#/buy link, signed out
    rememberNext('#/buy/' + slug);
    go('auth');
    banner('Sign in to place this order — we will bring you straight back.');
    return;
  }
  if (!opts.fromHistory) {
    const want = '#/buy/' + slug;
    if (location.hash !== want) history.pushState(null, '', want);
  }
  state.view = 'buy';
  renderShell();
  const v = $('view');
  v.textContent = '';

  const back = el('button', { type: 'button', className: 'ghost', textContent: '← Back' });
  back.onclick = () => history.back();
  v.append(back);

  const card = el('div', { className: 'card' });
  card.append(el('h1', { textContent: 'Place your order' }));
  v.append(card);
  const loading = el('p', { className: 'muted', textContent: 'Pricing…' });
  card.append(loading);

  let quote = null;
  const summary = el('div', { className: 'preview' });
  const form = el('form');

  const reprice = async qty => {
    try {
      const d = await api(`/api/orders?quote=${encodeURIComponent(slug)}&qty=${encodeURIComponent(qty)}`);
      quote = d.quote;
      summary.textContent = '';
      summary.append(
        el('b', { textContent: quote.totalLabel }),
        el('span', { textContent: `${quote.qty} × ${quote.unitExclLabel} per ${quote.unit}, excluding GST` }),
        el('span', { textContent: `+ ${quote.gstRate}% GST ${quote.taxTotalLabel}` }));
      if (quote.businessPricing) {
        summary.append(el('span', {}, el('span', { className: 'pill yellow', textContent: 'Trade price' })));
      }
      return true;
    } catch (x) { message(form, x.message); return false; }
  };

  try {
    const first = await api(`/api/orders?quote=${encodeURIComponent(slug)}`);
    quote = first.quote;
  } catch (x) {
    loading.remove();
    message(card, x.message);
    return;
  }
  loading.remove();

  card.append(el('h2', { textContent: quote.name }),
    el('p', { className: 'small muted', textContent: `${quote.categoryName} · sold per ${quote.unit}` }));

  const qtyInput = el('input', {
    id: 'o_qty', name: 'qty', type: 'number', inputMode: 'decimal',
    step: '0.001', min: String(quote.minOrderQty), value: String(quote.qty),
  });
  form.append(el('label', { htmlFor: 'o_qty' },
    el('span', { textContent: `Quantity (minimum ${quote.minOrderQty} ${quote.unit})` }), qtyInput));
  form.append(summary);

  const fieldset = el('fieldset', {}, el('legend', { textContent: 'Deliver to' }));
  const grid = el('div', { className: 'form-grid' });
  const f = (name, label, attrs = {}, full) => {
    const input = el('input', { id: 'o_' + name, name, ...attrs });
    return el('label', { htmlFor: 'o_' + name, className: full ? 'full' : '' },
      el('span', { textContent: label }), input);
  };
  const stateSel = el('select', { id: 'o_state', name: 'stateCode', required: true });
  stateSel.append(el('option', { value: '', textContent: 'Select a state' }));
  for (const s of (state.meta?.states || [])) {
    stateSel.append(el('option', { value: s.code, textContent: s.name }));
  }
  grid.append(
    f('name', 'Name', { required: true, value: state.user.fullName || '' }),
    f('phone', 'Mobile', { required: true, type: 'tel', value: state.user.phone || '' }),
    f('line1', 'Address', { required: true }, true),
    f('line2', 'Address line 2 (optional)', {}, true),
    f('city', 'City', { required: true }),
    f('pincode', 'PIN code', { required: true, inputMode: 'numeric', maxLength: 7 }),
    el('label', { htmlFor: 'o_state' }, el('span', { textContent: 'State' }), stateSel),
    f('note', 'Delivery note (optional)', { placeholder: 'Gate number, landmark, timing' }, true));
  fieldset.append(grid);
  form.append(fieldset);

  const place = el('button', { type: 'submit', className: 'primary', textContent: 'Place order' });
  form.append(el('div', { className: 'form-actions' }, place));
  form.append(el('p', { className: 'small muted', textContent:
    'No payment is taken here. You settle with the seller directly, and we show GST on every line.' }));
  card.append(form);

  let timer = null;
  qtyInput.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => reprice(qtyInput.value), 350);
  };

  form.onsubmit = async e => {
    e.preventDefault();
    message(form, '');
    place.disabled = true;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const d = await api('/api/orders?action=place', {
        method: 'POST',
        body: JSON.stringify({ ...data, slug, expectTotal: quote.total }),
      });
      banner(`Order ${d.order.reference} placed.`, 'good');
      history.replaceState(null, '', '#/order/' + d.order.reference);
      renderOrder(d.order);
    } catch (x) {
      // A price that moved under the customer is not an error they caused; re-quote and let them look.
      if (x.status === 409 && x.data?.totalLabel) {
        await reprice(qtyInput.value);
        message(form, x.message + ' New total: ' + x.data.totalLabel);
      } else {
        message(form, x.message);
      }
      place.disabled = false;
    }
  };

  await reprice(quote.qty);
}

function renderOrder(order) {
  state.view = 'order';
  renderShell();
  const v = $('view');
  v.textContent = '';

  const card = el('div', { className: 'card detail' });
  card.append(el('div', { className: 'cat small muted',
    textContent: 'ORDER ' + statusInfo(order.status).label.toUpperCase() }));
  card.append(el('h1', { textContent: order.reference }));
  card.append(el('p', { className: 'muted small', textContent:
    'Quote this code to the seller. No payment has been taken.' }));

  for (const i of order.items) {
    card.append(el('div', { className: 'order-line' },
      el('div', {}, el('b', { textContent: i.name }),
        el('div', { className: 'small muted', textContent:
          `${i.qty} ${i.unit} × ${i.unitPriceExcl} excl. GST · ${i.gstRate}% GST${i.hsnSac ? ' · HSN/SAC ' + i.hsnSac : ''}` })),
      el('div', { className: 'order-amt', textContent: i.lineTotalLabel })));
  }

  const dl = el('dl');
  const add = (k, val) => { if (val != null && val !== '') dl.append(el('dt', { textContent: k }), el('dd', { textContent: String(val) })); };
  add('Subtotal excluding GST', order.subtotalExcl);
  if (order.taxSplit === 'cgst_sgst') { add('CGST', order.cgst); add('SGST', order.sgst); }
  else if (order.taxSplit === 'igst') { add('IGST', order.igst); }
  else { add('GST', order.taxTotal); }
  add('Total', order.totalLabel);
  add('Sold by', order.soldBy);
  if (order.collection) {
    add('Collected', `${new Date(order.collection.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      + ` · ${metaLabel('collection_method', order.collection.method)}`);
  }
  add('Deliver to', `${order.shipTo.name}, ${order.shipTo.line1}${order.shipTo.line2 ? ', ' + order.shipTo.line2 : ''}, ${order.shipTo.city} ${order.shipTo.pincode}`);
  add('Contact', order.shipTo.phone);
  card.append(dl);

  const actions = el('div', { className: 'form-actions' });
  const mine = el('button', { type: 'button', className: 'ghost', textContent: 'My orders' });
  mine.onclick = () => go('orders');
  actions.append(mine);
  // Whether a customer may still withdraw this order is a row in mb_order_transitions, not a
  // comparison against 'placed' in two places that could disagree.
  for (const m of customerMoves(order.status)) {
    const b = el('button', {
      type: 'button', className: m.primary ? 'primary' : 'ghost', textContent: m.label,
    });
    b.onclick = async () => {
      // A move that needs a handover code is not something a button can do on its own: the proof is
      // the code on the seller's screen, so the button opens the scanner instead of posting.
      if (m.needsToken) return openScanner(order, m);
      let reason;
      if (m.needsReason) {
        reason = prompt('Why are you cancelling? The seller sees this.') ?? undefined;
        if (reason === undefined) return;
      }
      b.disabled = true;
      try {
        const d = await api('/api/orders?action=' + m.action, {
          method: 'POST', body: JSON.stringify({ reference: order.reference, reason }),
        });
        banner(`Order ${statusInfo(d.order.status).label.toLowerCase()}.`, 'good');
        renderOrder({ ...order, status: d.order.status });
      } catch (x) { banner(x.message, 'bad'); b.disabled = false; }
    };
    actions.append(b);
  }
  card.append(actions);
  v.append(card);
}

// Confirming a collection. The customer scans the code on the seller's screen; typing it is always
// offered, because a camera can be refused, unsupported, or just pointed at a dark yard — and an
// order that cannot be closed is worse than one closed by reading ten characters aloud.
function openScanner(order, move) {
  state.view = 'order';
  renderShell();
  const v = $('view');
  v.textContent = '';

  const card = el('div', { className: 'card detail' });
  card.append(el('h1', { textContent: move.label }));
  card.append(el('p', { className: 'muted small', textContent:
    `Scan the code on the seller's screen for ${order.reference}. Nothing is confirmed until you do.` }));
  v.append(card);

  const stage = el('div', { className: 'scanner' });
  const note = el('p', { className: 'small muted' });
  card.append(stage, note);

  let stream = null, timer = null, finished = false;
  const stop = () => {
    finished = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  };
  state.cleanup = stop;

  const submit = async raw => {
    if (!raw) { note.textContent = 'Enter the code from the seller\'s screen.'; return; }
    if (finished) return;
    stop();
    note.textContent = 'Confirming…';
    try {
      const d = await api('/api/orders?action=collect', {
        method: 'POST', body: JSON.stringify({ reference: order.reference, token: raw }),
      });
      cacheClear();
      banner(d.message || 'Collection confirmed.', 'good');
      openOrder(order.reference);
    } catch (x) {
      banner(x.message, 'bad');
      note.textContent = x.message;
      finished = false;                       // let them try the code again
    }
  };

  const typed = el('input', {
    placeholder: 'Or type the code', autocapitalize: 'characters',
    autocomplete: 'off', spellcheck: false, maxLength: 40,
  });
  const send = el('button', { type: 'button', className: 'primary', textContent: 'Confirm' });
  send.onclick = () => submit(typed.value.trim());
  typed.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); send.onclick(); } };
  const back = el('button', { type: 'button', className: 'ghost', textContent: 'Back to the order' });
  back.onclick = () => { stop(); openOrder(order.reference); };
  card.append(el('div', { className: 'form-actions' }, typed, send, back));

  (async () => {
    if (!('BarcodeDetector' in window)) {
      note.textContent = 'This browser cannot read codes with the camera. Type the code instead — '
        + 'it is shown under the square on the seller\'s screen.';
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      note.textContent = 'No camera is available here. Type the code instead.';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
    } catch {
      note.textContent = 'The camera was not allowed. Type the code instead.';
      return;
    }
    if (finished) { for (const t of stream.getTracks()) t.stop(); return; }

    const video = el('video', { muted: true, autoplay: true });
    video.setAttribute('playsinline', '');         // iOS plays inline only with the attribute
    video.srcObject = stream;
    stage.append(video);
    note.textContent = 'Point the camera at the square on the seller\'s screen.';

    let detector;
    try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); }
    catch { note.textContent = 'This browser cannot read QR codes. Type the code instead.'; return; }

    timer = setInterval(async () => {
      if (finished || !video.videoWidth) return;
      try {
        const found = await detector.detect(video);
        if (found.length && found[0].rawValue) submit(found[0].rawValue);
      } catch { /* a frame that will not decode is the normal case, not an error */ }
    }, 250);
  })();
}

async function openOrder(reference, opts = {}) {
  if (!state.user) { rememberNext('#/order/' + reference); go('auth'); return; }
  if (!opts.fromHistory) {
    const want = '#/order/' + reference;
    if (location.hash !== want) history.pushState(null, '', want);
  }
  state.view = 'order';
  renderShell();
  const v = $('view');
  v.textContent = 'Loading…';
  try {
    const d = await api('/api/orders?reference=' + encodeURIComponent(reference));
    renderOrder(d.order);
  } catch (x) { v.textContent = ''; message(v, x.message); }
}

async function renderOrders(v) {
  if (!state.user) return go('auth');
  v.append(el('h1', { textContent: 'My orders' }));
  const wrap = el('div');
  v.append(wrap);
  try {
    const { orders } = await api('/api/orders');
    if (!orders.length) {
      wrap.append(el('p', { className: 'empty', textContent: 'You have not ordered anything yet.' }));
      return;
    }
    const list = el('div', { className: 'more-list' });
    for (const o of orders) {
      const b = el('button', { type: 'button', className: 'more-link' },
        el('span', { className: 'more-link-icon' }, navIconEl('products')),
        el('span', { className: 'more-link-copy' },
          el('b', { textContent: o.reference }),
          el('small', { textContent: `${o.status} · ${o.lines} item${o.lines === 1 ? '' : 's'}` })),
        el('span', { className: 'more-link-count', textContent: o.totalLabel }),
        el('span', { className: 'more-link-arrow', textContent: '›' }));
      b.onclick = () => openOrder(o.reference);
      list.append(b);
    }
    wrap.append(list);
  } catch (x) { message(wrap, x.message); }
}

// --- customer account -------------------------------------------------------

function renderAccount(v) {
  const u = state.user;
  if (!u) return go('auth');
  const card = el('div', { className: 'card detail' });
  card.append(el('h1', { textContent: 'My account' }));
  const dl = el('dl');
  const add = (k, val) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: String(val ?? '—') }));
  add('Name', u.fullName);
  add('Email', u.email);
  add('Mobile', u.phone);
  add('You are', roleLabelOne(u.role));
  add('Account type', metaLabel('account_type', u.accountType));
  if (u.accountType === 'business') {
    add('Verification', metaLabel('business_status', u.businessStatus));
  }
  if (u.role === 'customer' && u.ownerStatus && u.ownerStatus !== 'none') {
    add('Selling here', metaLabel('owner_status', u.ownerStatus));
  }
  card.append(dl);

  // Asking to sell grants nothing. It records the request; an administrator decides.
  if (u.role === 'customer' && (u.ownerStatus === 'none' || !u.ownerStatus)) {
    const ask = el('button', { type: 'button', className: 'primary', textContent: 'Sell on matbyus' });
    ask.onclick = async () => {
      const note = prompt('Tell the matbyus team what you sell. (Optional)') ?? undefined;
      if (note === undefined) return;
      ask.disabled = true;
      try {
        const d = await api('/api/auth?action=request-owner', {
          method: 'POST', body: JSON.stringify({ note }),
        });
        state.user = { ...u, ownerStatus: d.ownerStatus };
        banner(d.message, 'good');
        go('account');
      } catch (x) { banner(x.message, 'bad'); ask.disabled = false; }
    };
    card.append(el('p', { className: 'small muted', textContent:
      'Have materials or services to sell? Ask to become an owner and the matbyus team will review it.' }));
    card.append(el('p', {}, ask));
  } else if (u.ownerStatus === 'requested') {
    card.append(el('p', { className: 'small muted', textContent:
      'Your request to sell on matbyus is with the team. You will be signed out once it is approved, and the owner screens appear when you sign back in.' }));
  }
  card.append(el('p', { className: 'small muted', textContent:
    'To change your password, contact the store team and we will set a new one for you.' }));
  v.append(card);
}

// --- the basket (FR-25.1, FR-25.2) --------------------------------------------
// A basket can span owners; checkout splits it into one order per owner. This screen shows the
// lines, prices them for display by asking the same quote endpoint the single-item buy flow uses
// (never trusting a client-held price — D-26), and checks out everything in one request.

async function renderBasket(v) {
  if (!state.user) return go('auth');
  v.append(el('h1', { textContent: 'Your basket' }));

  if (!state.basket.length) {
    v.append(el('p', { className: 'empty', textContent: 'Your basket is empty. Add something from Materials or Services.' }));
    return;
  }

  const list = el('div', { className: 'card' });
  v.append(list);
  const totalRow = el('div', { className: 'order-amt', style: 'font-size:1.1rem;margin-top:10px' });

  const quotes = {};
  const draw = async () => {
    list.textContent = '';
    await Promise.all(state.basket.map(async line => {
      try { quotes[line.slug] = (await api(`/api/orders?quote=${encodeURIComponent(line.slug)}&qty=${encodeURIComponent(line.qty)}`)).quote; }
      catch (x) { quotes[line.slug] = { error: x.message }; }
    }));

    let total = 0;
    for (const line of state.basket) {
      const q = quotes[line.slug];
      const row = el('div', { className: 'order-line' });
      if (q?.error) {
        row.append(el('div', {}, el('b', { textContent: line.slug }), el('div', { className: 'small muted', textContent: q.error })));
      } else {
        total += Number(q.total);
        row.append(el('div', {},
          el('b', { textContent: q.name }),
          el('div', { className: 'small muted', textContent: `${q.unit} · ${q.totalLabel} each line` })));
        const qty = el('input', {
          type: 'number', inputMode: 'decimal', step: '0.001', min: String(q.minOrderQty),
          value: String(line.qty), style: 'width:80px',
        });
        qty.onchange = () => { basketSetQty(line.slug, qty.value || q.minOrderQty); draw(); };
        row.append(qty);
        row.append(el('div', { className: 'order-amt', textContent: q.totalLabel }));
      }
      const rm = el('button', { type: 'button', className: 'ghost', textContent: 'Remove' });
      rm.onclick = () => { basketRemove(line.slug); draw(); };
      row.append(rm);
      list.append(row);
    }
    totalRow.textContent = state.basket.length ? `Basket total ${formatInrLike(total)}` : '';
  };
  await draw();
  v.append(totalRow);

  if (!state.basket.length) return;   // everything was removed while quoting

  const fieldset = el('fieldset', {}, el('legend', { textContent: 'Deliver to' }));
  const form = el('form');
  const grid = el('div', { className: 'form-grid' });
  const f = (name, label, attrs = {}, full) => {
    const input = el('input', { id: 'bk_' + name, name, ...attrs });
    return el('label', { htmlFor: 'bk_' + name, className: full ? 'full' : '' }, el('span', { textContent: label }), input);
  };
  const stateSel = el('select', { id: 'bk_state', name: 'stateCode', required: true });
  stateSel.append(el('option', { value: '', textContent: 'Select a state' }));
  for (const s of (state.meta?.states || [])) stateSel.append(el('option', { value: s.code, textContent: s.name }));
  grid.append(
    f('name', 'Name', { required: true, value: state.user.fullName || '' }),
    f('phone', 'Mobile', { required: true, type: 'tel', value: state.user.phone || '' }),
    f('line1', 'Address', { required: true }, true),
    f('line2', 'Address line 2 (optional)', {}, true),
    f('city', 'City', { required: true }),
    f('pincode', 'PIN code', { required: true, inputMode: 'numeric', maxLength: 7 }),
    el('label', { htmlFor: 'bk_state' }, el('span', { textContent: 'State' }), stateSel),
    f('note', 'Delivery note (optional)', {}, true));
  fieldset.append(grid);
  form.append(fieldset);
  const checkoutBtn = el('button', { type: 'submit', className: 'primary', textContent: 'Checkout' });
  form.append(el('div', { className: 'form-actions' }, checkoutBtn));
  v.append(form);

  form.onsubmit = async e => {
    e.preventDefault();
    message(form, '');
    checkoutBtn.disabled = true;
    const data = Object.fromEntries(new FormData(form).entries());
    const items = state.basket.map(l => ({ slug: l.slug, qty: l.qty, expectTotal: quotes[l.slug]?.total }));
    try {
      const d = await api('/api/orders?action=checkout', { method: 'POST', body: JSON.stringify({ ...data, items }) });
      state.basket = []; saveBasket();
      if (d.errors.length) {
        banner(`${d.orders.length} order(s) placed. ${d.errors.length} line(s) could not be ordered — see below.`, d.orders.length ? 'good' : 'bad');
      } else {
        banner(`${d.orders.length} order${d.orders.length === 1 ? '' : 's'} placed.`, 'good');
      }
      if (d.orders.length === 1 && !d.errors.length) {
        history.replaceState(null, '', '#/order/' + d.orders[0].reference);
        renderOrder(d.orders[0]);
      } else {
        go('orders');
      }
    } catch (x) { message(form, x.message); checkoutBtn.disabled = false; }
  };
}

function formatInrLike(paiseOrRupees) {
  // The quote endpoint already returns rupee strings/labels; this only sums the ones already
  // formatted by the server (quote.total), so this is plain arithmetic on numbers the server gave —
  // never a client-side reimplementation of the paise/GST math.
  return '₹' + Number(paiseOrRupees).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- messages (FR-23) ----------------------------------------------------------

async function startConversation(slug) {
  try {
    const d = await api('/api/messages?action=start', { method: 'POST', body: JSON.stringify({ slug }) });
    openMessageThread(d.conversation.id);
  } catch (x) { banner(x.message, 'bad'); }
}

async function renderMessages(v) {
  if (!state.user) return go('auth');
  v.append(el('h1', { textContent: 'Messages' }));
  const wrap = el('div');
  v.append(wrap);
  try {
    const { conversations } = await api('/api/messages');
    if (!conversations.length) {
      wrap.append(el('p', { className: 'empty', textContent: 'No conversations yet. Ask a seller a question from their listing.' }));
      return;
    }
    for (const c of conversations) {
      const row = el('button', { type: 'button', className: 'more-link' },
        el('span', { className: 'more-link-copy' },
          el('b', { textContent: c.with }),
          el('small', { textContent: c.product ? c.product.name : (c.lastMessage || 'No messages yet') })));
      if (c.unread) row.append(el('span', { className: 'more-link-count', textContent: String(c.unread) }));
      row.append(el('span', { className: 'more-link-arrow', textContent: '›' }));
      row.onclick = () => openMessageThread(c.id);
      wrap.append(row);
    }
  } catch (x) { message(wrap, x.message); }
}

async function openMessageThread(id, opts = {}) {
  if (!opts.fromHistory) {
    const want = '#/messages/' + id;
    if (location.hash !== want) history.pushState(null, '', want);
  }
  state.view = 'messages';
  renderShell();
  const v = $('view');
  v.textContent = '';
  const back = el('button', { type: 'button', className: 'ghost', textContent: '← Back' });
  back.onclick = () => go('messages');
  v.append(back);

  try {
    const d = await api('/api/messages?conversation=' + encodeURIComponent(id));
    refreshNotifications().then(renderShell);   // opening a thread cleared its unread count server-side

    const card = el('div', { className: 'card detail' });
    card.append(el('h1', { textContent: d.conversation.with }));
    if (d.conversation.product) card.append(el('p', { className: 'small muted', textContent: 'About ' + d.conversation.product.name }));
    v.append(card);

    const thread = el('div', { className: 'thread' });
    for (const m of d.messages) {
      thread.append(el('div', { className: 'msg-bubble' + (m.mine ? ' mine' : '') },
        el('div', { textContent: m.body }),
        el('div', { className: 'small muted', textContent: m.atLabel })));
    }
    v.append(thread);

    const form = el('form', { className: 'msg-compose' });
    const input = el('textarea', { rows: 2, placeholder: 'Write a message…', required: true });
    const send = el('button', { type: 'submit', className: 'primary', textContent: 'Send' });
    form.append(input, send);
    v.append(form);
    form.onsubmit = async e => {
      e.preventDefault();
      if (!input.value.trim()) return;
      send.disabled = true;
      try {
        const r = await api('/api/messages?action=send', {
          method: 'POST', body: JSON.stringify({ conversationId: id, body: input.value.trim() }),
        });
        thread.append(el('div', { className: 'msg-bubble mine' },
          el('div', { textContent: r.message.body }), el('div', { className: 'small muted', textContent: r.message.atLabel })));
        input.value = '';
        thread.scrollIntoView({ block: 'end' });
      } catch (x) { message(form, x.message); }
      send.disabled = false;
    };
  } catch (x) { message(v, x.message); }
}

// --- bids (FR-24) ---------------------------------------------------------------

async function openBidForm(slug, opts = {}) {
  if (!state.user) {
    rememberNext('#/bid/' + slug);
    go('auth');
    banner('Sign in to make an offer — we will bring you straight back.');
    return;
  }
  if (!opts.fromHistory) {
    const want = '#/bid/' + slug;
    if (location.hash !== want) history.pushState(null, '', want);
  }
  state.view = 'bid-form';
  renderShell();
  const v = $('view');
  v.textContent = '';
  const back = el('button', { type: 'button', className: 'ghost', textContent: '← Back' });
  back.onclick = () => history.back();
  v.append(back);

  try {
    const { product: p } = await api('/api/catalog?slug=' + encodeURIComponent(slug));
    const card = el('div', { className: 'card' });
    card.append(el('h1', { textContent: 'Make an offer' }),
      el('p', { className: 'muted small', textContent: `${p.name}${p.seller ? ' · sold by ' + p.seller.name : ''}` }));
    v.append(card);

    const form = el('form');
    const qty = el('input', {
      id: 'bid_qty', type: 'number', inputMode: 'decimal', step: '0.001',
      min: String(p.minOrderQty), value: String(p.minOrderQty), required: true,
    });
    form.append(el('label', { htmlFor: 'bid_qty' }, el('span', { textContent: `Quantity (${p.unitLabel})` }), qty));

    const price = el('input', { id: 'bid_price', type: 'number', inputMode: 'decimal', step: '0.01', min: '0' });
    form.append(el('label', { htmlFor: 'bid_price' },
      el('span', { textContent: p.pricingMode === 'quote' ? 'Your price (optional — ask for a quote instead)' : 'Your price, per unit, excluding GST' }),
      price));
    if (p.pricingMode === 'fixed') price.required = true;

    const note = el('textarea', { id: 'bid_note', rows: 2, placeholder: 'A note for the seller (optional)' });
    form.append(el('label', { htmlFor: 'bid_note' }, el('span', { textContent: 'Note' }), note));

    const send = el('button', { type: 'submit', className: 'primary', textContent: 'Send offer' });
    form.append(el('div', { className: 'form-actions' }, send));
    card.append(form);

    form.onsubmit = async e => {
      e.preventDefault();
      send.disabled = true;
      try {
        const r = await api('/api/bids?action=place', {
          method: 'POST', body: JSON.stringify({ slug, qty: qty.value, unitPrice: price.value || undefined, note: note.value }),
        });
        banner('Offer sent.', 'good');
        openBidDetail(r.bid.id);
      } catch (x) { message(form, x.message); send.disabled = false; }
    };
  } catch (x) { message(v, x.message); }
}

async function renderBids(v) {
  if (!state.user) return go('auth');
  v.append(el('h1', { textContent: isOwner() ? 'Offers received' : 'My offers' }));
  const wrap = el('div');
  v.append(wrap);
  try {
    const { bids } = await api('/api/bids');
    if (!bids.length) {
      wrap.append(el('p', { className: 'empty', textContent: 'No offers yet.' }));
      return;
    }
    for (const b of bids) {
      const row = el('button', { type: 'button', className: 'more-link' },
        el('span', { className: 'more-link-copy' },
          el('b', { textContent: `${b.product.name} · ${b.qty} ${b.unit}` }),
          el('small', { textContent: `${b.with} · ${b.statusLabel}${b.unitPriceLabel ? ' · ' + b.unitPriceLabel : ''}` })));
      if (b.turn === b.mySide && ['open', 'countered'].includes(b.status)) {
        row.append(el('span', { className: 'pill yellow', textContent: 'Your move' }));
      }
      row.append(el('span', { className: 'more-link-arrow', textContent: '›' }));
      row.onclick = () => openBidDetail(b.id);
      wrap.append(row);
    }
  } catch (x) { message(wrap, x.message); }
}

async function openBidDetail(id, opts = {}) {
  if (!opts.fromHistory) {
    const want = '#/bids/' + id;
    if (location.hash !== want) history.pushState(null, '', want);
  }
  state.view = 'bids';
  renderShell();
  const v = $('view');
  v.textContent = '';
  const back = el('button', { type: 'button', className: 'ghost', textContent: '← Back' });
  back.onclick = () => go('bids');
  v.append(back);

  const draw = async () => {
    v.querySelectorAll('.card, .msg').forEach(n => n.remove());
    try {
      const d = await api('/api/bids?id=' + encodeURIComponent(id));
      const b = d.bid;
      refreshNotifications().then(renderShell);

      const card = el('div', { className: 'card detail' });
      card.append(el('div', { className: 'cat small muted', textContent: b.statusLabel.toUpperCase() }));
      card.append(el('h1', { textContent: b.product.name }));
      card.append(el('p', { className: 'muted small', textContent: `${b.with} · ${b.qty} ${b.unit}` }));
      if (b.unitPriceLabel) card.append(el('div', { className: 'headline', textContent: `${b.unitPriceLabel} / ${b.unit}` }));
      if (b.totalLabel) card.append(el('p', { className: 'small muted', textContent: `${b.totalLabel} total, excluding GST` }));
      v.append(card);

      const hist = el('div', { className: 'thread' });
      for (const m of d.moves) {
        hist.append(el('div', { className: 'small muted', textContent:
          `${m.atLabel} · ${m.by} ${m.action}${m.toPriceLabel ? ' → ' + m.toPriceLabel : ''}${m.note ? ' — ' + m.note : ''}` }));
      }
      v.append(hist);

      if (['open', 'countered'].includes(b.status)) {
        const isMyTurn = b.turn === b.mySide;
        const actions = el('div', { className: 'form-actions' });

        if (isMyTurn) {
          const accept = el('button', { type: 'button', className: 'primary', textContent: 'Accept' });
          accept.onclick = async () => {
            if (b.unitPrice == null) { banner('There is no price yet to accept.', 'bad'); return; }
            // Accepting creates an order, so — same as the direct buy flow — it needs a delivery
            // address. Reused inline rather than a whole second screen, since it is the one extra
            // step that makes "accept" meaningful.
            const addr = promptAddress();
            if (!addr) return;
            accept.disabled = true;
            try {
              const r = await api('/api/bids?action=accept', { method: 'POST', body: JSON.stringify({ id, ...addr }) });
              banner(`Order ${r.order.reference} placed.`, 'good');
              history.replaceState(null, '', '#/order/' + r.order.reference);
              renderOrder(r.order);
            } catch (x) { banner(x.message, 'bad'); accept.disabled = false; }
          };
          const reject = el('button', { type: 'button', className: 'ghost', textContent: 'Decline' });
          reject.onclick = async () => {
            const note = prompt('A reason, if you like (optional).') ?? undefined;
            if (note === undefined) return;
            try { await api('/api/bids?action=reject', { method: 'POST', body: JSON.stringify({ id, note }) }); draw(); banner('Declined.', 'good'); }
            catch (x) { banner(x.message, 'bad'); }
          };
          const counterPrice = el('input', { type: 'number', inputMode: 'decimal', step: '0.01', min: '0', placeholder: 'Your price', style: 'width:110px' });
          const counter = el('button', { type: 'button', className: 'ghost', textContent: 'Counter' });
          counter.onclick = async () => {
            if (!counterPrice.value) { banner('Enter a price to counter with.', 'bad'); return; }
            try {
              await api('/api/bids?action=counter', { method: 'POST', body: JSON.stringify({ id, unitPrice: counterPrice.value }) });
              draw(); banner('Counter sent.', 'good');
            } catch (x) { banner(x.message, 'bad'); }
          };
          actions.append(accept, reject, counterPrice, counter);
        } else {
          actions.append(el('p', { className: 'muted small', textContent: `Waiting on ${b.with}.` }));
        }
        if (b.mySide === 'customer') {
          const withdraw = el('button', { type: 'button', className: 'ghost', textContent: 'Withdraw' });
          withdraw.onclick = async () => {
            try { await api('/api/bids?action=withdraw', { method: 'POST', body: JSON.stringify({ id }) }); draw(); banner('Offer withdrawn.', 'good'); }
            catch (x) { banner(x.message, 'bad'); }
          };
          actions.append(withdraw);
        }
        v.append(actions);
      }
    } catch (x) { message(v, x.message); }
  };
  await draw();
}

// A minimal inline address prompt for accepting a bid — see openBidDetail(). Kept to the four
// fields an order cannot do without; anything more belongs on the full checkout screen, not here.
function promptAddress() {
  const line1 = prompt('Delivery address:');
  if (!line1) return null;
  const city = prompt('City:') || '';
  const pincode = prompt('PIN code:') || '';
  const stateCode = prompt('State code (e.g. 33 for Tamil Nadu):') || '';
  return { line1, city, pincode, stateCode };
}

// --- notifications (FR-28) -------------------------------------------------------

async function renderNotifications(v) {
  if (!state.user) return go('auth');
  const head = el('div', { className: 'admin-head' });
  head.append(el('h1', { textContent: 'Notifications' }));
  const markAll = el('button', { type: 'button', className: 'ghost', textContent: 'Mark all read' });
  head.append(markAll);
  v.append(head);
  const wrap = el('div');
  v.append(wrap);

  const open = n => {
    api('/api/notifications?action=read', { method: 'POST', body: JSON.stringify({ id: n.id }) }).catch(() => {});
    refreshNotifications().then(renderShell);
    if (n.link) { history.pushState(null, '', n.link); routeFromHash(false); }
  };

  try {
    const d = await api('/api/notifications');
    state.unreadNotifications = d.unread;
    renderShell();
    if (!d.notifications.length) {
      wrap.append(el('p', { className: 'empty', textContent: 'Nothing yet.' }));
      return;
    }
    markAll.onclick = async () => {
      await api('/api/notifications?action=read', { method: 'POST', body: JSON.stringify({ all: true }) });
      state.unreadNotifications = 0; renderShell();
      wrap.querySelectorAll('.pill').forEach(p => p.remove());
    };
    for (const n of d.notifications) {
      const row = el('button', { type: 'button', className: 'more-link' },
        el('span', { className: 'more-link-copy' },
          el('b', { textContent: n.title }),
          el('small', { textContent: (n.body ? n.body + ' · ' : '') + n.atLabel })));
      if (!n.read) row.append(el('span', { className: 'pill yellow', textContent: 'New' }));
      row.onclick = () => open(n);
      wrap.append(row);
    }
  } catch (x) { message(wrap, x.message); }
}

// --- admin ------------------------------------------------------------------

// A guard is a redirect, not a permission. Every screen below also fails safe because the API it
// calls refuses the caller independently — this only spares them a screen full of 403s.
function roleGuard(roles) {
  if (!state.user || !roles.includes(state.user.role)) { go('auth'); return false; }
  return true;
}
const adminGuard = () => roleGuard(['admin']);
const sellerGuard = () => roleGuard(['admin', 'owner']);
const isOwner = () => state.user?.role === 'owner';

async function renderDashboard(v) {
  if (!sellerGuard()) return;
  if (isOwner()) return renderOwnerDashboard(v);
  v.append(el('h1', { textContent: 'Store dashboard' }));
  const card = el('div', { className: 'card' });
  card.append(el('p', { className: 'muted', textContent: 'Loading…' }));
  v.append(card);
  try {
    const [{ customers }, { products }, { approvals }] = await Promise.all([
      api('/api/admin?resource=customers'), api('/api/admin?resource=products'), api('/api/admin?resource=approvals'),
    ]);
    card.textContent = '';
    const stat = (label, n) => el('div', { className: 'stat' },
      el('b', { textContent: String(n) }), el('span', { textContent: label }));
    const row = el('div', { className: 'stats' });
    row.append(stat('Customers', customers.length), stat('Products', products.length),
      stat('Live products', products.filter(p => p.is_active).length), stat('Awaiting approval', approvals.length));
    card.append(row);
    if (approvals.length) {
      const b = el('button', { type: 'button', className: 'primary', textContent: `Review ${approvals.length} business account${approvals.length === 1 ? '' : 's'}` });
      b.onclick = () => go('approvals');
      card.append(el('p', {}, b));
    }
  } catch (x) { card.textContent = ''; message(card, x.message); }
}

// An owner's dashboard is their own figures and nothing else. It reads the same two endpoints the
// admin dashboard does; the server narrows them to this owner, so there is no separate owner API
// to keep in step — and no way for this screen to show a number that is not theirs.
async function renderOwnerDashboard(v) {
  v.append(el('h1', { textContent: 'My sales' }));
  const card = el('div', { className: 'card' });
  card.append(el('p', { className: 'muted', textContent: 'Loading…' }));
  v.append(card);
  try {
    const [orders, { products }] = await Promise.all([
      api('/api/admin?resource=orders'), api('/api/admin?resource=products'),
    ]);
    card.textContent = '';
    const stat = (label, n) => el('div', { className: 'stat' },
      el('b', { textContent: String(n) }), el('span', { textContent: label }));
    const open = (state.meta?.orderStatuses || []).filter(x => x.open)
      .reduce((n, x) => n + (orders.counts[x.code] || 0), 0);
    const row = el('div', { className: 'stats' });
    row.append(
      stat('Listings', products.length),
      stat('Live', products.filter(x => x.is_active).length),
      stat('Orders in hand', open),
      stat('Collected', orders.counts.collected || 0));
    card.append(row);

    const newOnes = orders.counts.placed || 0;
    if (newOnes) {
      const b = el('button', { type: 'button', className: 'primary',
        textContent: `Accept ${newOnes} new order${newOnes === 1 ? '' : 's'}` });
      b.onclick = () => go('storeorders');
      card.append(el('p', {}, b));
    } else {
      card.append(el('p', { className: 'small muted', textContent:
        'Nothing waiting. New orders appear here and under Orders received the moment a customer places one.' }));
    }
    if (!products.length) {
      card.append(el('p', { className: 'small muted', textContent:
        'You have no listings yet — add one under My listings and put it live to start selling.' }));
    }
  } catch (x) { card.textContent = ''; message(card, x.message); }
}

async function renderApprovals(v) {
  if (!adminGuard()) return;
  v.append(el('h1', { textContent: 'Business approvals' }));
  const card = el('div', { className: 'card' });
  v.append(card);
  const load = async () => {
    card.textContent = 'Loading…';
    try {
      const { approvals } = await api('/api/admin?resource=approvals');
      card.textContent = '';
      if (!approvals.length) { card.append(el('p', { className: 'empty', textContent: 'Nothing waiting.' })); return; }
      for (const a of approvals) {
        const row = el('div', { className: 'detail', style: 'border-bottom:1px solid var(--mb-border);padding:12px 0' });
        row.append(el('h2', { textContent: a.legalName }));
        const dl = el('dl');
        const add = (k, val) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: String(val ?? '—') }));
        add('Contact', `${a.fullName || ''} · ${a.email} · ${a.phone}`);
        add('GSTIN', a.gstin || 'not provided');
        add('PAN', a.pan);
        add('State', `${a.stateName} (${a.stateCode})`);
        add('City', `${a.city} ${a.pincode}`);
        row.append(dl);
        const note = el('input', { placeholder: 'Reason, shown to them if rejected' });
        const act = (label, action, cls) => {
          const b = el('button', { type: 'button', className: cls, textContent: label });
          b.onclick = async () => {
            b.disabled = true;
            try {
              await api(`/api/admin?resource=customers&action=${action}`, {
                method: 'POST', body: JSON.stringify({ id: a.id, note: note.value.trim() || undefined }),
              });
              banner(`${a.legalName} ${action === 'approve' ? 'approved' : 'rejected'}.`, 'good');
              load();
            } catch (x) { message(row, x.message); b.disabled = false; }
          };
          return b;
        };
        row.append(note, el('div', { className: 'actions', style: 'display:flex;gap:8px;margin-top:8px' },
          act('Approve', 'approve', 'primary'), act('Reject', 'reject', 'ghost')));
        card.append(row);
      }
    } catch (x) { card.textContent = ''; message(card, x.message); }
  };
  load();
}

// Admin only: every owner, what each has sold, who is asking to join, and who runs the place.
// The brief's "Karthi and Viju see the owner list and how much they sold" is this screen.
async function renderOwners(v) {
  if (!adminGuard()) return;
  v.append(el('h1', { textContent: 'Owners' }));
  const wrap = el('div');
  v.append(wrap);

  const load = async () => {
    wrap.textContent = '';
    wrap.append(el('p', { className: 'muted small', textContent: 'Loading…' }));
    let d;
    try { d = await api('/api/admin?resource=owners'); }
    catch (x) { wrap.textContent = ''; message(wrap, x.message); return; }
    wrap.textContent = '';

    const act = (o, action, label, cls) => {
      const b = el('button', { type: 'button', className: cls, textContent: label });
      b.onclick = async () => {
        let note;
        if (action === 'reject') {
          note = prompt('Why? They can be told this.') ?? undefined;
          if (note === undefined) return;
        }
        if (action === 'revoke-admin' &&
            !confirm(`Remove ${o.fullName || o.email} as an administrator?`)) return;
        b.disabled = true;
        try {
          const r = await api('/api/admin?resource=owners&action=' + action, {
            method: 'POST', body: JSON.stringify({ id: o.id, note }),
          });
          banner(r.message || 'Done.', 'good');
          load();
        } catch (x) { banner(x.message, 'bad'); b.disabled = false; }
      };
      return b;
    };

    const requests = d.owners.filter(o => o.ownerStatus === 'requested');
    if (requests.length) {
      const s = el('section', { className: 'card' });
      s.append(el('h2', { textContent: `Asking to sell here (${requests.length})` }));
      s.append(el('p', { className: 'small muted', textContent:
        'Approving creates the owner account and signs them out, so the owner screens appear on their next sign-in.' }));
      for (const o of requests) {
        const row = el('div', { className: 'detail', style: 'border-top:1px solid var(--mb-border);padding:12px 0' });
        row.append(el('b', { textContent: o.fullName || o.email }));
        row.append(el('div', { className: 'small muted', textContent:
          [o.email, o.phone, o.legalName, o.stateName].filter(Boolean).join(' · ') }));
        row.append(el('div', { className: 'form-actions' },
          act(o, 'approve', 'Approve', 'primary'), act(o, 'reject', 'Not now', 'ghost')));
        s.append(row);
      }
      wrap.append(s);
    }

    const sellers = d.owners.filter(o => o.role === 'owner');
    const s2 = el('section');
    s2.append(el('h2', { textContent: `Selling here (${sellers.length})` }));
    if (!sellers.length) {
      s2.append(el('p', { className: 'empty', textContent: 'No owners yet.' }));
    } else {
      const t = el('table');
      t.append(el('thead', {}, el('tr', {}, ...['Owner', 'State', 'Listings', 'Live', 'Orders', 'Sold', '']
        .map(h => el('th', { textContent: h })))));
      const tb = el('tbody');
      for (const o of sellers) {
        tb.append(el('tr', {},
          el('td', {}, el('b', { textContent: o.fullName || o.email }),
            el('div', { className: 'small muted', textContent: o.email })),
          el('td', { textContent: o.stateName || '—' }),
          el('td', { textContent: String(o.listings) }),
          el('td', { textContent: String(o.live) }),
          el('td', { textContent: String(o.orders) }),
          el('td', { className: 'order-amt', textContent: o.soldLabel }),
          el('td', {}, el('div', { style: 'display:flex;gap:6px' },
            act(o, 'grant-admin', 'Make admin', 'ghost'),
            act(o, 'reject', 'Remove', 'ghost')))));
      }
      t.append(tb);
      s2.append(el('div', { className: 'table-wrap' }, t));
    }
    wrap.append(s2);

    const s3 = el('section');
    s3.append(el('h2', { textContent: `Administrators (${d.admins.length})` }));
    s3.append(el('p', { className: 'small muted', textContent:
      'Only an administrator can add another. Nobody can remove their own administrator role, and matbyus refuses to be left without one.' }));
    const list = el('div', { className: 'more-list' });
    for (const a of d.admins) {
      const row = el('div', { className: 'more-link', style: 'cursor:default' },
        el('span', { className: 'more-link-copy' },
          el('b', { textContent: (a.fullName || a.email) + (a.isYou ? ' — you' : '') }),
          el('small', { textContent: a.email })));
      if (!a.isYou) row.append(act(a, 'revoke-admin', 'Remove', 'ghost'));
      list.append(row);
    }
    s3.append(list);
    wrap.append(s3);
  };

  load();
}

async function renderAdminCustomers(v) {
  if (!adminGuard()) return;
  v.append(el('h1', { textContent: 'Customers' }));
  const filters = el('div', { className: 'filters' });
  const q = el('input', { type: 'search', placeholder: 'Email or name', id: 'c_q' });
  const type = el('select', { id: 'c_t' });
  type.append(el('option', { value: '', textContent: 'All account types' }),
    el('option', { value: 'individual', textContent: 'Individual' }),
    el('option', { value: 'business', textContent: 'Business' }));
  const btn = el('button', { type: 'button', className: 'primary', textContent: 'Search' });
  filters.append(el('label', { htmlFor: 'c_q' }, el('span', { textContent: 'Search' }), q),
    el('label', { htmlFor: 'c_t' }, el('span', { textContent: 'Type' }), type), btn);
  v.append(filters);

  const wrap = el('div', { className: 'table-wrap' });
  v.append(wrap);
  const load = async () => {
    wrap.textContent = '';
    const p = new URLSearchParams({ resource: 'customers' });
    if (q.value.trim()) p.set('q', q.value.trim());
    if (type.value) p.set('accountType', type.value);
    try {
      const { customers } = await api('/api/admin?' + p);
      if (!customers.length) { wrap.append(el('p', { className: 'empty', textContent: 'No customers match.' })); return; }
      const t = el('table');
      t.append(el('thead', {}, el('tr', {}, ...['Email', 'Name', 'Mobile', 'Type', 'Verification', 'Role']
        .map(h => el('th', { textContent: h })))));
      const tb = el('tbody');
      for (const c of customers) {
        tb.append(el('tr', {},
          el('td', { textContent: c.email }), el('td', { textContent: c.fullName || '—' }),
          el('td', { textContent: c.phone }), el('td', { textContent: c.accountType }),
          el('td', { textContent: c.businessStatus === 'none' ? '—' : c.businessStatus }),
          el('td', { textContent: c.role })));
      }
      t.append(tb);
      wrap.append(t);
    } catch (x) { message(wrap, x.message); }
  };
  btn.onclick = load; type.onchange = load;
  q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); load(); } };
  load();
}

// --- admin: product form (FR-8) ---------------------------------------------

// R9: an admin typing a retail price is entering the figure EXCLUDING GST, which is not what a
// price usually means to someone used to MRP. The field says so and the inclusive figure is
// computed beside it as they type, so the convention is visible rather than documented.
function productForm(v, existing, categories, onDone) {
  const editing = !!existing;
  const card = el('div', { className: 'card' });
  card.append(el('h1', { textContent: editing ? `Edit ${existing.name}` : 'Add a product' }));
  const form = el('form');
  card.append(form);
  v.append(card);

  const val = k => (existing && existing[k] != null ? String(existing[k]) : '');
  const inputs = {};

  const field = (name, label, attrs = {}, hint, full) => {
    const id = 'p_' + name;
    const node = attrs.tag === 'select'
      ? el('select', { id, name })
      : attrs.tag === 'textarea'
        ? el('textarea', { id, name, value: val(name) })
        : el('input', { id, name, value: val(name), ...attrs });
    inputs[name] = node;
    const l = el('label', { htmlFor: id, className: full ? 'full' : '' }, el('span', { textContent: label }), node);
    if (hint) l.append(el('small', { className: 'muted', textContent: hint }));
    return l;
  };

  const kindSel = el('select', { id: 'p_kind', name: 'kind' });
  for (const { code: k, label: lbl } of metaRows('product_kind')) {
    kindSel.append(el('option', { value: k, textContent: lbl, selected: val('kind') === k }));
  }
  inputs.kind = kindSel;

  const catSel = el('select', { id: 'p_category_id', name: 'category_id' });
  inputs.category_id = catSel;

  const unitSel = el('select', { id: 'p_unit', name: 'unit' });
  inputs.unit = unitSel;

  const modeSel = el('select', { id: 'p_pricing_mode', name: 'pricing_mode' });
  for (const [k, lbl] of [['fixed', 'Fixed price'], ['quote', 'Quote on request']]) {
    modeSel.append(el('option', { value: k, textContent: lbl, selected: val('pricing_mode') === k }));
  }
  inputs.pricing_mode = modeSel;

  const stockSel = el('select', { id: 'p_stock_status', name: 'stock_status' });
  for (const { code: k, label: lbl } of metaRows('stock_status')) {
    stockSel.append(el('option', { value: k, textContent: lbl, selected: val('stock_status') === k }));
  }
  inputs.stock_status = stockSel;

  const basics = el('fieldset', {}, el('legend', { textContent: 'What it is' }));
  const g1 = el('div', { className: 'form-grid' });
  g1.append(
    field('name', 'Product name', { required: true, placeholder: 'OPC 53 Grade Cement — 50 kg' }, null, true),
    el('label', { htmlFor: 'p_kind' }, el('span', { textContent: 'Kind' }), kindSel),
    el('label', { htmlFor: 'p_category_id' }, el('span', { textContent: 'Category' }), catSel),
    field('sku', 'SKU', { required: true, placeholder: 'CEM-OPC53-50' }),
    field('slug', 'Web address', { required: true, placeholder: 'opc-53-cement-50kg' }, 'Lower case, hyphens.'),
    field('summary', 'Short description', { placeholder: 'One line shown on the card' }, null, true),
    field('description', 'Full description', { tag: 'textarea' }, null, true));
  basics.append(g1);
  form.append(basics);

  const selling = el('fieldset', {}, el('legend', { textContent: 'How it is sold' }));
  const g2 = el('div', { className: 'form-grid' });
  g2.append(
    el('label', { htmlFor: 'p_unit' }, el('span', { textContent: 'Sold per' }), unitSel),
    field('min_order_qty', 'Minimum order', { type: 'number', step: '0.001', min: '0' }),
    field('pack_size', 'Pack size', { type: 'number', step: '0.001', min: '0' }, 'Materials only — 50 for a 50 kg bag.'),
    field('stock_qty', 'Stock quantity', { type: 'number', step: '0.001', min: '0' }, 'Materials only.'),
    el('label', { htmlFor: 'p_stock_status' }, el('span', { textContent: 'Availability' }), stockSel));
  selling.append(g2);
  form.append(selling);

  const pricing = el('fieldset', {}, el('legend', { textContent: 'Price and tax' }));
  const preview = el('div', { className: 'preview' });
  const g3 = el('div', { className: 'form-grid' });
  g3.append(
    el('label', { htmlFor: 'p_pricing_mode' }, el('span', { textContent: 'Pricing' }), modeSel),
    field('gst_rate', 'GST rate %', { type: 'number', step: '0.01', min: '0', max: '100' },
      `Usual rates: ${metaRows('gst_rate').map(r => r.label).join(', ')}. Confirm with your tax adviser.`),
    field('price_retail', 'Retail price — EXCLUDING GST', { type: 'number', step: '0.01', min: '0' },
      'The figure before tax. The customer sees the inclusive price below.'),
    field('price_business', 'Trade price — EXCLUDING GST', { type: 'number', step: '0.01', min: '0' },
      'Shown only to approved business accounts. Leave blank for none.'),
    field('hsn_sac', 'HSN / SAC code', { placeholder: '2523' }, 'Required before it can go live.'));
  pricing.append(g3, preview);
  form.append(pricing);

  // --- live behaviour -------------------------------------------------------

  const inr = paise => '₹' + (paise / 100).toFixed(2).replace(/\B(?=(\d{2})+(?!\d)(?=\d{3}))/g, '');
  const fmt = n => {
    const s = n.toFixed(2).split('.');
    const last3 = s[0].slice(-3), rest = s[0].slice(0, -3);
    return '₹' + (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + last3 + '.' + s[1];
  };

  const refresh = () => {
    const kind = kindSel.value;
    const isService = kind === 'service';

    // units belong to their kind — the schema refuses the wrong pairing, so do not offer it
    const want = u => (u.kind === 'both' || u.kind === kind);
    const current = unitSel.value || val('unit');
    unitSel.textContent = '';
    for (const u of (state.meta?.units || []).filter(want)) {
      unitSel.append(el('option', { value: u.key, textContent: u.label, selected: u.key === current }));
    }

    catSel.textContent = '';
    const mine = categories.filter(c => c.kind === kind);
    if (!mine.length) catSel.append(el('option', { value: '', textContent: 'No ' + kind + ' categories yet' }));
    for (const c of mine) {
      catSel.append(el('option', { value: c.id, textContent: c.name, selected: String(c.id) === val('category_id') }));
    }

    for (const k of ['pack_size', 'stock_qty']) {
      inputs[k].disabled = isService;
      inputs[k].closest('label').style.opacity = isService ? '.45' : '';
      if (isService) inputs[k].value = '';
    }
    stockSel.disabled = isService;

    const quote = modeSel.value === 'quote';
    for (const k of ['price_retail', 'price_business']) {
      inputs[k].disabled = quote;
      inputs[k].closest('label').style.opacity = quote ? '.45' : '';
      if (quote) inputs[k].value = '';
    }

    preview.textContent = '';
    if (quote) {
      preview.append(el('span', { textContent: 'Customers see “Request a quote”. No price is stored.' }));
      return;
    }
    const retail = Number(inputs.price_retail.value || 0);
    const rate = Number(inputs.gst_rate.value || 0);
    const tax = Math.round(retail * rate) / 100;
    preview.append(
      el('b', { textContent: fmt(retail + tax) }),
      el('span', { textContent: `is what a retail customer sees — ${fmt(retail)} plus ${rate || 0}% GST ${fmt(tax)}` }));
    const trade = Number(inputs.price_business.value || 0);
    if (trade > 0) {
      preview.append(el('span', { textContent: `· approved businesses see ${fmt(trade)} excluding GST` }));
    }
  };

  kindSel.onchange = refresh;
  modeSel.onchange = refresh;
  for (const k of ['price_retail', 'price_business', 'gst_rate']) inputs[k].oninput = refresh;

  // a slug is a chore to type, so derive it until the admin edits it themselves
  let slugTouched = editing;
  inputs.slug.oninput = () => { slugTouched = true; };
  inputs.name.oninput = () => {
    if (slugTouched) return;
    inputs.slug.value = inputs.name.value.toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  };

  const save = el('button', { type: 'submit', className: 'primary', textContent: editing ? 'Save changes' : 'Create product' });
  const cancel = el('button', { type: 'button', className: 'ghost', textContent: 'Cancel' });
  cancel.onclick = () => onDone();
  form.append(el('div', { className: 'form-actions' }, save, cancel));

  form.onsubmit = async e => {
    e.preventDefault();
    message(form, '');
    save.disabled = true;
    const body = {};
    for (const [k, node] of Object.entries(inputs)) {
      if (node.disabled) { body[k] = null; continue; }
      const v2 = String(node.value ?? '').trim();
      body[k] = v2 === '' ? null : v2;
    }
    if (editing) body.id = existing.id;
    try {
      await api(`/api/admin?resource=products&action=${editing ? 'update' : 'create'}`,
        { method: 'POST', body: JSON.stringify(body) });
      cacheClear();
      banner(editing ? 'Product saved.' : 'Product created as a draft. Put it live when you are ready.', 'good');
      onDone();
    } catch (x) {
      message(form, x.message);
      save.disabled = false;
    }
  };

  refresh();
}

// --- store side: orders received (FR-25.6) ----------------------------------

async function renderStoreOrders(v) {
  if (!sellerGuard()) return;

  const head = el('div', { className: 'admin-head' });
  head.append(el('h1', { textContent: 'Orders received' }));
  if (isOwner()) {
    head.append(el('span', { className: 'pill', textContent: 'Yours only' }));
  }
  v.append(head);

  const chips = el('div', { className: 'chips' });
  v.append(chips);
  const wrap = el('div');
  v.append(wrap);

  let filter = '';

  const drawChips = counts => {
    chips.textContent = '';
    // One chip per status in mb_order_statuses, in the order the table gives.
    const tabs = [['', 'All', null],
      ...(state.meta?.orderStatuses || []).map(st => [st.code, st.sellerLabel || st.label, counts[st.code]])];
    for (const [key, label, n] of tabs) {
      const b = el('button', { type: 'button', className: 'chip' }, label);
      if (n != null) b.append(el('span', { className: 'n', textContent: String(n) }));
      b.setAttribute('aria-pressed', String(filter === key));
      b.onclick = () => { filter = key; load(); };
      chips.append(b);
    }
  };

  const load = async () => {
    wrap.textContent = '';
    wrap.append(el('p', { className: 'muted small', textContent: 'Loading…' }));
    try {
      const d = await api('/api/admin?resource=orders' + (filter ? '&status=' + filter : ''));
      drawChips(d.counts);
      wrap.textContent = '';
      if (!d.orders.length) {
        wrap.append(el('p', { className: 'empty', textContent:
          filter ? `No ${filter} orders.` : 'No orders yet. They appear here the moment a customer places one.' }));
        return;
      }
      for (const o of d.orders) wrap.append(orderCard(o, load));
    } catch (x) { wrap.textContent = ''; message(wrap, x.message); }
  };

  load();
}

function orderCard(o, reload) {
  const card = el('div', { className: 'card order-card' });

  const top = el('div', { className: 'order-top' });
  top.append(el('div', {},
    el('b', { className: 'order-ref', textContent: o.reference }),
    el('div', { className: 'small muted', textContent: new Date(o.placedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) })));
  const st = statusInfo(o.status);
  const statusPill = el('span', {
    className: 'pill' + (st.tone && st.tone !== 'plain' ? ' ' + st.tone : ''),
    textContent: st.sellerLabel || st.label,
  });
  top.append(el('div', { style: 'text-align:right' }, statusPill,
    el('div', { className: 'order-amt', style: 'margin-top:6px', textContent: o.totalLabel })));
  card.append(top);

  card.append(el('div', { className: 'order-summary', textContent: o.summary || `${o.lines} item(s)` }));

  // An owner only ever sees their own orders, so whose it is only needs saying to an admin.
  if (!isOwner()) {
    card.append(el('div', { className: 'small muted', textContent:
      'Sold by ' + (o.seller ? (o.seller.name || o.seller.email) : 'matbyus') }));
  }

  const who = el('div', { className: 'small muted' });
  who.append(`${o.customer.name || o.customer.email}`);
  if (o.customer.accountType === 'business') {
    who.append(' ', el('span', {
      className: 'pill' + (o.customer.businessStatus === 'approved' ? ' yellow' : ''),
      textContent: o.customer.businessStatus === 'approved' ? 'Trade' : 'Business ' + o.customer.businessStatus,
    }));
  }
  card.append(who);

  const ship = o.shipTo;
  card.append(el('div', { className: 'small', textContent:
    `${ship.name} · ${ship.phone}` }));
  card.append(el('div', { className: 'small muted', textContent:
    [ship.line1, ship.line2, ship.city, ship.pincode, ship.state].filter(Boolean).join(', ') }));
  if (ship.note) card.append(el('div', { className: 'small muted', textContent: 'Note: ' + ship.note }));
  if (o.collection) {
    card.append(el('div', { className: 'small muted', textContent:
      `Collected ${new Date(o.collection.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · ${metaLabel('collection_method', o.collection.method).toLowerCase()}` }));
  }
  if (o.cancelReason) card.append(el('div', { className: 'small muted', textContent: 'Reason: ' + o.cancelReason }));
  if (o.taxSplit === 'unsplit') {
    card.append(el('div', { className: 'small muted', textContent:
      `GST ${o.taxTotal} — regime not set. Set MB_SELLER_STATE_CODE to split CGST/SGST or IGST.` }));
  }

  // mb_order_transitions decides what this order can do next and what each button says. The API
  // checks the same rows, so the screen cannot offer a move the server will refuse.
  // The customer confirms by scanning, and which states allow that is their own transition rows —
  // so this screen cannot offer a code at a moment the API would refuse to issue one.
  if (customerMoves(o.status).some(m => m.needsToken)) card.append(handoverPanel(o, reload));

  const moves = sellerMoves(o.status);
  if (moves.length) {
    const actions = el('div', { className: 'form-actions' });
    for (const m of moves) {
      const b = el('button', { type: 'button', className: m.primary ? 'primary' : 'ghost', textContent: m.label });
      b.onclick = async () => {
        let reason;
        if (m.needsReason) {
          reason = prompt('Why is this order being cancelled? The customer sees this.') ?? undefined;
          if (reason === undefined) return;
        }
        for (const x of actions.querySelectorAll('button')) x.disabled = true;
        try {
          await api(`/api/admin?resource=orders&action=${m.action}`, {
            method: 'POST', body: JSON.stringify({ reference: o.reference, reason }),
          });
          banner(`${o.reference} — ${statusInfo(m.to).label.toLowerCase()}.`, 'good');
          reload();
        } catch (x) {
          banner(x.message, 'bad');
          reload();                       // the screen was stale; show what is actually true
        }
      };
      actions.append(b);
    }
    card.append(actions);
  }
  return card;
}

// The code a customer scans. Single use, short-lived, and replaced outright every time this asks
// for one — so the square on screen is the only one that works and an old screenshot is worthless.
function handoverPanel(o, reload) {
  const wrap = el('div', { className: 'handover' });
  const open = el('button', { type: 'button', className: 'ghost', textContent: 'Show collection code' });
  const body = el('div', { hidden: true });
  wrap.append(open, body);

  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  const load = async () => {
    stop();
    body.hidden = false;
    body.textContent = '';
    body.append(el('p', { className: 'small muted', textContent: 'Getting a code…' }));
    let handover;
    try {
      ({ handover } = await api('/api/admin?resource=orders&action=handover-token', {
        method: 'POST', body: JSON.stringify({ reference: o.reference }),
      }));
    } catch (x) { body.textContent = ''; message(body, x.message); return; }

    body.textContent = '';
    const fig = el('div', { className: 'qr' });
    // Drawn here from the code, not fetched as an image: an image request would put the handover
    // code in a URL, in a log, and in the browser's history.
    fig.innerHTML = qrSvg(handover.payload, { scale: 6, quiet: 3, dark: '#0D0D0D', light: '#FFFFFF' });
    body.append(fig);
    body.append(el('p', { className: 'handover-code', textContent: handover.token }));
    body.append(el('p', { className: 'small muted', textContent:
      'The customer scans this in their matbyus app, or you read the code to them. It can be used once.' }));

    const left = el('p', { className: 'small muted' });
    body.append(left);
    const again = el('button', { type: 'button', className: 'ghost', textContent: 'New code' });
    again.onclick = load;
    const refresh = el('button', { type: 'button', className: 'ghost', textContent: 'Refresh orders' });
    refresh.onclick = () => { stop(); reload(); };
    body.append(el('div', { className: 'form-actions' }, again, refresh));

    const until = new Date(handover.expiresAt).getTime();
    const tick = () => {
      if (!document.body.contains(left)) { stop(); return; }   // the card was redrawn under us
      const secs = Math.max(0, Math.round((until - Date.now()) / 1000));
      left.textContent = secs
        ? `Expires in ${secs}s. The order moves to collected the moment they scan.`
        : 'That code has expired. Tap “New code”.';
      if (!secs) stop();
    };
    tick();
    timer = setInterval(tick, 1000);
  };

  open.onclick = () => { open.hidden = true; load(); };
  return wrap;
}

async function renderAdminProducts(v) {
  if (!sellerGuard()) return;

  const head = el('div', { className: 'admin-head' });
  head.append(el('h1', { textContent: isOwner() ? 'My listings' : 'Products' }));
  const add = el('button', { type: 'button', className: 'primary',
    textContent: isOwner() ? '+ Add a listing' : '+ Add product' });
  head.append(add);
  v.append(head);

  const wrap = el('div', { className: 'table-wrap' });
  v.append(wrap);

  let categories = [];
  const openForm = async product => {
    v.textContent = '';
    if (!categories.length) {
      try { categories = (await api('/api/admin?resource=categories')).categories; } catch { categories = []; }
    }
    productForm(v, product, categories, () => go('products'));
  };
  add.onclick = () => openForm(null);
  const load = async () => {
    wrap.textContent = 'Loading…';
    try {
      const { products } = await api('/api/admin?resource=products');
      wrap.textContent = '';
      if (!products.length) {
        wrap.append(el('p', { className: 'empty', textContent: isOwner()
          ? 'No listings yet. Add one and it appears in the catalogue once you put it live.'
          : 'No products yet.' }));
        return;
      }
      const showOwner = !isOwner();
      const t = el('table');
      t.append(el('thead', {}, el('tr', {}, ...['Name', 'SKU', 'Kind', 'Unit', 'Retail', 'Trade', 'GST', 'Code',
        ...(showOwner ? ['Sold by'] : []), 'Live', '']
        .map(h => el('th', { textContent: h })))));
      const tb = el('tbody');
      for (const p of products) {
        const toggle = el('button', {
          type: 'button', className: p.is_active ? 'ghost' : 'primary',
          textContent: p.is_active ? 'Take offline' : 'Put live',
        });
        toggle.onclick = async () => {
          toggle.disabled = true;
          try {
            await api(`/api/admin?resource=products&action=${p.is_active ? 'deactivate' : 'activate'}`,
              { method: 'POST', body: JSON.stringify({ id: p.id }) });
            cacheClear();
            load();
          } catch (x) { banner(x.message, 'bad'); toggle.disabled = false; }
        };
        const edit = el('button', { type: 'button', className: 'ghost', textContent: 'Edit' });
        edit.onclick = () => openForm(p);

        tb.append(el('tr', {},
          el('td', { textContent: p.name }), el('td', { textContent: p.sku }),
          el('td', { textContent: p.kind }), el('td', { textContent: p.unit }),
          el('td', { textContent: p.price_retail ?? 'quote' }),
          el('td', { textContent: p.price_business ?? '—' }),
          el('td', { textContent: p.gst_rate + '%' }),
          el('td', { textContent: p.hsn_sac || '—' }),
          ...(showOwner ? [el('td', { textContent: p.owner_name || p.owner_email || 'matbyus' })] : []),
          el('td', {}, el('span', { className: 'pill' + (p.is_active ? ' yellow' : ''), textContent: p.is_active ? 'Live' : 'Draft' })),
          el('td', {}, el('div', { style: 'display:flex;gap:6px' }, edit, toggle))));
      }
      t.append(tb);
      wrap.append(t);
    } catch (x) { wrap.textContent = ''; message(wrap, x.message); }
  };
  load();
}

async function renderPermissions(v) {
  if (!adminGuard()) return;
  v.append(el('h1', { textContent: 'Permissions' }));
  v.append(el('p', { className: 'muted small', textContent:
    'Choose which menus each role sees. This changes what the app shows, not what anyone is allowed '
    + 'to do — every endpoint checks the role for itself, so hiding a menu is not a way to keep '
    + 'someone out of their data, and showing one grants nothing.' }));

  const wrap = el('div');
  v.append(wrap);

  const load = async () => {
    wrap.textContent = 'Loading…';
    try {
      const { roles } = await api('/api/admin?resource=permissions');
      wrap.textContent = '';
      for (const r of roles) {
        const card = el('div', { className: 'card' });
        const head = el('div', { className: 'admin-head' });
        head.append(el('h2', { textContent: r.role === 'admin' ? 'Administrators' : r.role === 'owner' ? 'Owners' : 'Customers' }));
        head.append(el('span', { className: 'pill' + (r.locked ? '' : ' yellow'),
          textContent: r.locked ? 'Always sees everything' : `${r.menus.length} of ${r.all.length}` }));
        card.append(head);
        card.append(el('p', { className: 'small muted', textContent:
          `${r.users} account${r.users === 1 ? '' : 's'}` + (r.locked
            ? ' · an administrator who could hide their own Permissions menu could lock themselves out of undoing it'
            : '') }));

        const list = el('div', { className: 'perm-grid' });
        const boxes = [];
        for (const m of r.all) {
          const on = r.menus.includes(m.key);
          const always = r.alwaysOn.includes(m.key);
          const cb = el('input', { type: 'checkbox', checked: on || always, disabled: r.locked || always });
          cb.dataset.key = m.key;
          boxes.push(cb);
          list.append(el('label', { className: 'perm-item' }, cb,
            el('span', {}, m.label, always ? el('small', { className: 'muted', textContent: ' always on' }) : null)));
        }
        card.append(list);

        if (!r.locked) {
          const save = el('button', { type: 'button', className: 'primary', textContent: 'Save menus' });
          save.onclick = async () => {
            save.disabled = true;
            try {
              const menus = boxes.filter(b => b.checked).map(b => b.dataset.key);
              const d = await api('/api/admin?resource=permissions&action=save', {
                method: 'POST', body: JSON.stringify({ role: r.role, menus }),
              });
              banner(`Saved. ${d.role} accounts see ${d.menus.length} menu${d.menus.length === 1 ? '' : 's'} on their next refresh.`, 'good');
              load();
            } catch (x) { message(card, x.message); save.disabled = false; }
          };
          card.append(el('div', { className: 'form-actions' }, save));
        }
        wrap.append(card);
      }
    } catch (x) { wrap.textContent = ''; message(wrap, x.message); }
  };
  load();
}

async function renderAdminCategories(v) {
  if (!adminGuard(v)) return;
  v.append(el('h1', { textContent: 'Categories' }));
  const wrap = el('div', { className: 'table-wrap' });
  v.append(wrap);
  const load = async () => {
    wrap.textContent = 'Loading…';
    try {
      const { categories } = await api('/api/admin?resource=categories');
      wrap.textContent = '';
      if (!categories.length) { wrap.append(el('p', { className: 'empty', textContent: 'No categories yet.' })); return; }
      const t = el('table');
      t.append(el('thead', {}, el('tr', {}, ...['Name', 'Slug', 'Kind', 'Active'].map(h => el('th', { textContent: h })))));
      const tb = el('tbody');
      for (const c of categories) {
        tb.append(el('tr', {}, el('td', { textContent: c.name }), el('td', { textContent: c.slug }),
          el('td', { textContent: c.kind }),
          el('td', {}, el('span', { className: 'pill' + (c.is_active ? ' yellow' : ''), textContent: c.is_active ? 'Active' : 'Hidden' }))));
      }
      t.append(tb);
      wrap.append(t);
    } catch (x) { wrap.textContent = ''; message(wrap, x.message); }
  };
  load();
}

// --- boot -------------------------------------------------------------------

const KNOWN_VIEWS = ['materials', 'services', 'account', 'auth', 'more', 'orders', 'storeorders', 'permissions',
  'dashboard', 'products', 'categories', 'customers', 'approvals', 'owners',
  'basket', 'messages', 'bids', 'notifications'];

// Returns whether the hash named a screen. go() and openProduct() return nothing, so this must
// report the match itself rather than pass their result on — doing that made every route look like
// a miss and fall through to the front page.
function routeFromHash(fromHistory) {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  if (raw.startsWith('p/') && raw.length > 2) {
    openProduct(raw.slice(2), { fromHistory });
    return true;
  }
  if (raw.startsWith('buy/') && raw.length > 4) {
    openBuy(raw.slice(4), { fromHistory });
    return true;
  }
  if (raw.startsWith('order/') && raw.length > 6) {
    openOrder(raw.slice(6), { fromHistory });
    return true;
  }
  if (raw.startsWith('bid/') && raw.length > 4) {
    openBidForm(raw.slice(4), { fromHistory });
    return true;
  }
  if (raw.startsWith('bids/') && raw.length > 5) {
    openBidDetail(raw.slice(5), { fromHistory });
    return true;
  }
  if (raw.startsWith('messages/') && raw.length > 9) {
    openMessageThread(raw.slice(9), { fromHistory });
    return true;
  }
  if (!KNOWN_VIEWS.includes(raw)) return false;
  // A customer landing on an admin URL is still refused by the API; adminGuard sends them to
  // sign-in, so a stale link is a redirect rather than a broken page.
  go(raw, { fromHistory });
  return true;
}

window.addEventListener('popstate', () => {
  if (!routeFromHash(true)) go(homeView(), { fromHistory: true });
});

(async function start() {
  // Every list the screens draw — states, units, roles, order statuses, the moves an order can
  // make, and the labels for each small enum — comes from here, which reads the lookup tables.
  // If it cannot be read the app still runs, showing codes where labels would be, and says so.
  try {
    state.meta = await api('/api/meta');
  } catch {
    state.meta = { states: [], units: [], roles: [], orderStatuses: [], orderFlow: {}, customerFlow: {}, lookups: {} };
    banner('Reference data could not be loaded. Some lists and labels will be incomplete.', 'bad');
  }
  try {
    const d = await api('/api/auth');
    state.user = d.user;
  } catch { state.user = null; }

  state.basket = loadBasket();
  if (state.user) await refreshNotifications();

  // A shared or reloaded URL opens the screen it names, not the front page.
  if (!routeFromHash(true)) {
    go(homeView(), { fromHistory: true });
  }

  if (state.user?.accountType === 'business' && state.user.businessStatus === 'pending') {
    banner('Your business account is being verified. You are seeing retail prices until it is approved.');
  }
})();
