// Sample catalog, so a fresh deployment has something to look at. Idempotent: re-running changes
// nothing. Remove these rows before real trading begins.
//
// *** EVERY gst_rate AND hsn_sac BELOW IS A PLACEHOLDER. ***
// Rates and codes for construction goods and services move by notification and differ by product.
// They are per-product values for the owner's tax adviser to set (FSD A2). Nothing here is advice,
// and no rate is hard-coded anywhere else in matbyus.
//
// Usage:  node --env-file=.env.production.local scripts/seed-demo.mjs

import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);

const CATEGORIES = [
  { slug: 'cement', name: 'Cement', kind: 'material', sort: 1 },
  { slug: 'steel-tmt', name: 'Steel & TMT', kind: 'material', sort: 2 },
  { slug: 'sand-aggregate', name: 'Sand & Aggregate', kind: 'material', sort: 3 },
  { slug: 'bricks-blocks', name: 'Bricks & Blocks', kind: 'material', sort: 4 },
  { slug: 'finishing', name: 'Finishing', kind: 'material', sort: 5 },
  { slug: 'masonry-services', name: 'Masonry & Plastering', kind: 'service', sort: 1 },
  { slug: 'contracting', name: 'Contracting', kind: 'service', sort: 2 },
];

const PRODUCTS = [
  { sku: 'CEM-OPC53-50', slug: 'opc-53-cement-50kg', name: 'OPC 53 Grade Cement — 50 kg',
    kind: 'material', category: 'cement', unit: 'bag', pack_size: 50,
    summary: 'Ordinary Portland Cement, 53 grade, for structural concrete.',
    description: 'Suitable for RCC work, precast and high-strength concrete. Stored under cover.',
    price_retail: '420.00', price_business: '395.00', min_order_qty: 10,
    stock_qty: 1200, stock_status: 'in_stock', hsn_sac: '2523', gst_rate: '28.00' },

  { sku: 'CEM-PPC-50', slug: 'ppc-cement-50kg', name: 'PPC Cement — 50 kg',
    kind: 'material', category: 'cement', unit: 'bag', pack_size: 50,
    summary: 'Portland Pozzolana Cement for general masonry and plastering.',
    price_retail: '390.00', price_business: '368.00', min_order_qty: 10,
    stock_qty: 800, stock_status: 'in_stock', hsn_sac: '2523', gst_rate: '28.00' },

  { sku: 'TMT-FE500D-12', slug: 'tmt-bar-12mm-fe500d', name: 'TMT Bar 12 mm — Fe500D',
    kind: 'material', category: 'steel-tmt', unit: 'tonne',
    summary: 'Fe500D reinforcement bar, 12 mm, 12 m lengths.',
    description: 'Ductile grade reinforcement for earthquake-resistant detailing.',
    price_retail: '62000.00', price_business: '60500.00', min_order_qty: 0.5,
    stock_qty: 24, stock_status: 'in_stock', hsn_sac: '7214', gst_rate: '18.00' },

  { sku: 'SAND-M-BRASS', slug: 'm-sand-brass', name: 'M-Sand — per brass',
    kind: 'material', category: 'sand-aggregate', unit: 'brass',
    summary: 'Manufactured sand, washed, for concrete and plaster. 1 brass = 100 cft.',
    price_retail: '5600.00', price_business: '5300.00', min_order_qty: 1,
    stock_qty: 40, stock_status: 'in_stock', hsn_sac: '2505', gst_rate: '5.00' },

  { sku: 'AGG-20MM-BRASS', slug: 'aggregate-20mm-brass', name: '20 mm Aggregate — per brass',
    kind: 'material', category: 'sand-aggregate', unit: 'brass',
    summary: 'Crushed stone aggregate, 20 mm, graded.',
    price_retail: '4800.00', price_business: '4550.00', min_order_qty: 1,
    stock_qty: 18, stock_status: 'low', hsn_sac: '2517', gst_rate: '5.00' },

  { sku: 'BRK-RED-1000', slug: 'red-clay-bricks', name: 'Red Clay Bricks',
    kind: 'material', category: 'bricks-blocks', unit: 'number',
    summary: 'First-class table-moulded clay bricks, 230 x 110 x 75 mm.',
    price_retail: '9.50', price_business: '8.80', min_order_qty: 1000,
    stock_qty: 45000, stock_status: 'in_stock', hsn_sac: '6904', gst_rate: '5.00' },

  { sku: 'BLK-AAC-600', slug: 'aac-block-600x200x150', name: 'AAC Block 600 x 200 x 150 mm',
    kind: 'material', category: 'bricks-blocks', unit: 'number',
    summary: 'Autoclaved aerated concrete block, lightweight.',
    price_retail: '62.00', price_business: '58.00', min_order_qty: 100,
    stock_qty: 0, stock_status: 'out_of_stock', hsn_sac: '6810', gst_rate: '12.00' },

  { sku: 'PNT-EMUL-20L', slug: 'interior-emulsion-20l', name: 'Interior Emulsion Paint — 20 L',
    kind: 'material', category: 'finishing', unit: 'litre', pack_size: 20,
    summary: 'Washable interior emulsion, matt finish.',
    price_retail: '4200.00', price_business: '3950.00', min_order_qty: 1,
    stock_qty: 60, stock_status: 'in_stock', hsn_sac: '3209', gst_rate: '18.00' },

  { sku: 'SVC-PLASTER', slug: 'wall-plastering', name: 'Wall Plastering',
    kind: 'service', category: 'masonry-services', unit: 'per_sqft',
    summary: 'Internal and external wall plastering, 12 mm, with finish.',
    description: 'Includes material and labour. Scaffolding above ground floor quoted separately.',
    price_retail: '28.00', price_business: '25.00', min_order_qty: 100,
    hsn_sac: '995465', gst_rate: '18.00' },

  { sku: 'SVC-MASON-DAY', slug: 'mason-per-day', name: 'Mason — per day',
    kind: 'service', category: 'masonry-services', unit: 'per_day',
    summary: 'Skilled mason, eight-hour day, site within city limits.',
    price_retail: '1100.00', price_business: '1000.00', min_order_qty: 1,
    hsn_sac: '995465', gst_rate: '18.00' },

  { sku: 'SVC-TURNKEY', slug: 'turnkey-contracting', name: 'Turnkey Contracting',
    kind: 'service', category: 'contracting', unit: 'lumpsum', pricing_mode: 'quote',
    summary: 'Design-to-handover contracting. Priced per project after a site visit.',
    description: 'Structure, finishes, services and handover under one contract.',
    min_order_qty: 1, hsn_sac: '995411', gst_rate: '18.00' },
];

const ids = new Map();
for (const c of CATEGORIES) {
  const [row] = await sql.query(
    `INSERT INTO mb_categories (slug, name, kind, sort_order)
     VALUES ($1,$2,$3,$4) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, slug`, [c.slug, c.name, c.kind, c.sort]);
  ids.set(row.slug, row.id);
}
console.log(`categories: ${ids.size}`);

let added = 0, skipped = 0;
for (const p of PRODUCTS) {
  const { category, ...row } = p;
  row.category_id = ids.get(category);
  row.is_active = true;
  row.pricing_mode = row.pricing_mode || 'fixed';
  const cols = Object.keys(row);
  const res = await sql.query(
    `INSERT INTO mb_products (${cols.join(',')})
     VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})
     ON CONFLICT (sku) DO NOTHING RETURNING sku`, cols.map(c => row[c]));
  if (res.length) added++; else skipped++;
}
console.log(`products: ${added} added, ${skipped} already present`);
console.log('Sample data. Confirm every HSN/SAC code and GST rate with your tax adviser before trading.');
