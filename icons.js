// Inline SVG icons for categories. Drawn rather than photographed: Phase 1 has no product imagery,
// and a line icon reads better at chip size than a cropped photo would.
//
// Matching is by category slug first, then by keywords in the name, so a category the owner adds
// later ("TMT Steel", "Floor Tiles") still picks up a sensible icon without a code change.

const svg = (...paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.join('')}</svg>`;

const ICONS = {
  cement: svg('<path d="M7 8h10l1.5 11H5.5L7 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><path d="M9.5 12h5"/>'),
  steel: svg('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/><path d="M7 5v4"/><path d="M13 10v4"/><path d="M17 15v4"/>'),
  sand: svg('<path d="M3 19h18"/><path d="M5 19 12 7l7 12"/><path d="M9.5 13h5"/>'),
  brick: svg('<path d="M3 9h18v6H3z"/><path d="M3 12h18"/><path d="M8 9v3"/><path d="M16 9v3"/><path d="M11 12v3"/>'),
  paint: svg('<path d="M5 7h14v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7Z"/><path d="M5 7l1-3h12l1 3"/><path d="M12 15v5"/>'),
  tile: svg('<path d="M4 4h7v7H4z"/><path d="M13 4h7v7h-7z"/><path d="M4 13h7v7H4z"/><path d="M13 13h7v7h-7z"/>'),
  pipe: svg('<path d="M4 8h8a4 4 0 0 1 4 4v8"/><path d="M2 6h4v4H2z"/><path d="M14 18h4v4h-4z"/>'),
  trowel: svg('<path d="M3 11l8-8 4 4-8 8-4-4Z"/><path d="M14 14l7 7"/><path d="M12 16l3 3"/>'),
  helmet: svg('<path d="M3 16a9 9 0 0 1 18 0"/><path d="M3 16h18v2H3z"/><path d="M9 7.5V6a3 3 0 0 1 6 0v1.5"/>'),
  crane: svg('<path d="M4 20h16"/><path d="M8 20V4h12"/><path d="M8 8l8-4"/><path d="M16 4v6"/><path d="M14 10h4"/>'),
  box: svg('<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>'),
};

const BY_SLUG = {
  cement: 'cement',
  'steel-tmt': 'steel', steel: 'steel',
  'sand-aggregate': 'sand', sand: 'sand', aggregate: 'sand',
  'bricks-blocks': 'brick', bricks: 'brick', blocks: 'brick',
  finishing: 'paint', paint: 'paint', tiles: 'tile',
  plumbing: 'pipe', electrical: 'pipe',
  'masonry-services': 'trowel', masonry: 'trowel', plastering: 'trowel',
  contracting: 'crane', labour: 'helmet', services: 'helmet',
};

const KEYWORDS = [
  [/cement|opc|ppc/i, 'cement'],
  [/steel|tmt|rebar|iron|rod/i, 'steel'],
  [/sand|aggregate|gravel|jelly|m-?sand/i, 'sand'],
  [/brick|block|aac/i, 'brick'],
  [/paint|emulsion|primer|finish/i, 'paint'],
  [/tile|marble|granite|floor/i, 'tile'],
  [/pipe|plumb|electric|wire|fitting/i, 'pipe'],
  [/plaster|mason|brickwork|render/i, 'trowel'],
  [/contract|turnkey|project|build/i, 'crane'],
  [/labour|mason|worker|helper|day/i, 'helmet'],
];

// Navigation icons, keyed by the menu keys in api/_roles.js. A bottom tab bar needs a glyph per
// item — a row of words alone is hard to hit and harder to scan at a glance.
const NAV = {
  materials: svg('<path d="M3 9h18v6H3z"/><path d="M3 12h18"/><path d="M8 9v3"/><path d="M16 9v3"/><path d="M11 12v3"/>'),
  services: svg('<path d="M3 11l8-8 4 4-8 8-4-4Z"/><path d="M14 14l7 7"/><path d="M12 16l3 3"/>'),
  account: svg('<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  auth: svg('<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  dashboard: svg('<path d="M4 4h7v7H4z"/><path d="M13 4h7v4h-7z"/><path d="M13 10h7v10h-7z"/><path d="M4 13h7v7H4z"/>'),
  products: svg('<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>'),
  categories: svg('<path d="M3 6h7v7H3z"/><path d="M14 3.5 20.5 10 17 13.5 10.5 7 14 3.5Z"/><path d="M3 16h18v5H3z"/>'),
  customers: svg('<circle cx="9" cy="8" r="3"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M16 6.5a3 3 0 0 1 0 5.5"/><path d="M17 14a6 6 0 0 1 4 5"/>'),
  owners: svg('<path d="M4 9h16l-1-4.5H5L4 9Z"/><path d="M5 9v11h14V9"/><path d="M9.5 20v-6h5v6"/>'),
  storeorders: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7"/><path d="M9 17h4"/>'),
  orders: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7"/><path d="M9 17h4"/>'),
  permissions: svg('<circle cx="8" cy="7" r="2"/><path d="M3 7h3"/><path d="M10 7h11"/><circle cx="16" cy="14" r="2"/><path d="M3 14h11"/><path d="M18 14h3"/><path d="M3 20h18"/>'),
  more: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'),
  messages: svg('<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8"/><path d="M8 12h5"/>'),
  bids: svg('<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>'),
  basket: svg('<path d="M4 9h16l-1.5 11a1.5 1.5 0 0 1-1.5 1.3H7a1.5 1.5 0 0 1-1.5-1.3L4 9Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>'),
  bell: svg('<path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z"/><path d="M10 19a2 2 0 0 0 4 0"/>'),
  estimate: svg('<path d="M6 3h12v18H6z"/><path d="M9 7h6"/><path d="M9 11h2"/><path d="M13 11h2"/><path d="M9 15h2"/><path d="M13 15h2"/>'),
  aisettings: svg('<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z"/>'),
  approvals: svg('<path d="M12 3l2.2 1.6 2.7-.2.9 2.6 2.2 1.6-1 2.6 1 2.6-2.2 1.6-.9 2.6-2.7-.2L12 21l-2.2-1.6-2.7.2-.9-2.6L4 15.4l1-2.6-1-2.6 2.2-1.6.9-2.6 2.7.2L12 3Z"/><path d="M9 12.2l2 2 4-4.2"/>'),
};

export function navIcon(key) { return NAV[key] || NAV.dashboard; }

export function navIconEl(key, className = 'ico') {
  const s = document.createElement('span');
  s.className = className;
  s.innerHTML = navIcon(key);
  return s;
}

export function categoryIcon(slug, name = '') {
  const key = BY_SLUG[String(slug || '').toLowerCase()];
  if (key) return ICONS[key];
  for (const [re, k] of KEYWORDS) if (re.test(slug + ' ' + name)) return ICONS[k];
  return ICONS.box;
}

// A span carrying the SVG. The markup is built here from a fixed table, never from user input.
export function iconEl(slug, name, className = 'ico') {
  const s = document.createElement('span');
  s.className = className;
  s.innerHTML = categoryIcon(slug, name);
  return s;
}
