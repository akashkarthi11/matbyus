-- Menu entries for messages and bids, alongside the screens migration 0005 already seeded.
-- Customers and owners both negotiate, so both get both menus; what differs is the label.
--
-- Forward-only. 0000-0009 are applied in production and are never edited.

INSERT INTO mb_menus (role, key, label, sort_order, always_on) VALUES
  ('customer', 'messages', 'Messages', 5, false),
  ('customer', 'bids',     'My offers', 6, false),
  ('owner',    'messages', 'Messages', 5, false),
  ('owner',    'bids',     'Offers',    6, false)
ON CONFLICT (role, key) DO NOTHING;
