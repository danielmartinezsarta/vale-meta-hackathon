-- Vale hackathon schema. All data stored here is invented demo data.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'health')),
  private_for_glimmer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  es TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  price_cents INTEGER NOT NULL,
  duration_min INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS supplies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  es TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  unit TEXT NOT NULL DEFAULT 'pcs',
  content_per_product REAL NOT NULL DEFAULT 1,
  stock_qty REAL NOT NULL DEFAULT 0,
  min_qty REAL NOT NULL DEFAULT 0,
  price_per_product_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS service_supplies (
  service_id INTEGER NOT NULL REFERENCES services(id),
  supply_id INTEGER NOT NULL REFERENCES supplies(id),
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  PRIMARY KEY (service_id, supply_id)
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  day TEXT NOT NULL,
  time TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS shopping_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supply_id INTEGER NOT NULL UNIQUE REFERENCES supplies(id),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_s INTEGER,
  margin_earned REAL,
  privacy_notice_sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_supplies (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  supply_id INTEGER NOT NULL REFERENCES supplies(id),
  PRIMARY KEY (session_id, supply_id)
);
CREATE TABLE IF NOT EXISTS write_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  extra TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
