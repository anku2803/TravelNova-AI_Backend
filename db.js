const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      title TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      messages TEXT,
      reply TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // Create bookings table to store tour and event bookings
  db.run(
    `CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tour_id INTEGER,
      tour_title TEXT,
      user_name TEXT,
      user_email TEXT,
      booking_date TEXT,
      passengers INTEGER,
      total_price REAL,
      payment_status TEXT DEFAULT 'Paid',
      payment_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // Create merchant_account table to store total revenue
  db.run(
    `CREATE TABLE IF NOT EXISTS merchant_account (
      id INTEGER PRIMARY KEY,
      balance REAL DEFAULT 0.00
    )`
  );

  // Seed default merchant account if not exists
  db.run(
    `INSERT OR IGNORE INTO merchant_account (id, balance) VALUES (1, 0.00)`
  );

  // Performance Optimization: Create Indexes for lightning fast lookups under heavy traffic
  db.run(`CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_user_email ON bookings(user_email)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at)`);
});

module.exports = db;

