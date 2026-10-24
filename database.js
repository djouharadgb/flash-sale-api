const Database = require("better-sqlite3");

// The database is one file (it is created if it doesn't exist)
const db = new Database("shop.db");

// Make SQLite enforce the links between tables (orders -> users, orders -> products)
db.pragma("foreign_keys = ON");

// database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    stock INTEGER NOT NULL CHECK (stock >= 0)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    total_price INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, idempotency_key)
  );
`);

// sample products for tests
// Only added if the table is empty. Prices are in cents (14999 = $149.99).
const productCount = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;

if (productCount === 0) {
  const insert = db.prepare("INSERT INTO products (name, price, stock) VALUES (?, ?, ?)");

  const sampleProducts = [
    ["Wireless Headphones", 14999, 10],  // 10 units our main test product
    ["Mechanical Keyboard", 8999, 5],
    ["Gaming Mouse", 4999, 1],           // only 1 unit great for race tests
    ["USB-C Hub", 3999, 50],
    ["Limited Edition Sneakers", 24999, 3],
  ];

  for (const product of sampleProducts) {
    insert.run(product[0], product[1], product[2]);
  }

  console.log("Sample products added");
}

module.exports = db;