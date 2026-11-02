-- Vale hackathon schema. All data stored here is invented demo data.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sex TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  birthday TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'health_note')),
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
  reference_photo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS shopping_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supply_id INTEGER NOT NULL UNIQUE REFERENCES supplies(id),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- HACK-018 demo reminders. A shopping reminder links to shopping_list rows
-- through reminder_items; other reminders (calls, errands) stand alone.
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'shopping', 'call')),
  day TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS reminder_items (
  reminder_id INTEGER NOT NULL REFERENCES reminders(id),
  shopping_list_id INTEGER NOT NULL REFERENCES shopping_list(id),
  PRIMARY KEY (reminder_id, shopping_list_id)
);
-- HACK-018 demo visits: past appointments with a photo marker for the card.
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  service_id INTEGER REFERENCES services(id),
  visited_at TEXT NOT NULL,
  photo TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_s INTEGER,
  margin_earned REAL,
  privacy_notice_sent INTEGER NOT NULL DEFAULT 0,
  photo_path TEXT
);
CREATE TABLE IF NOT EXISTS session_supplies (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  supply_id INTEGER NOT NULL REFERENCES supplies(id),
  PRIMARY KEY (session_id, supply_id)
);
-- HACK-018 demo payments: session_quote Accept (or a spoken amount after
-- Reject) registers here. The session stays open; the sheet shows the total.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  amount_usd REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'vale')),
  text TEXT NOT NULL,
  tool TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS turns_client_key_id ON turns (client_key, id);
CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
