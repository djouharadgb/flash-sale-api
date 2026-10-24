require("dotenv").config();

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

// Stop the server if the secret is missing
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing in the .env file");
  process.exit(1);
}

// A fake hash, used when the email doesn't exist (keeps response time equal)
const fakeHash = bcrypt.hashSync("not-a-real-password", 10);

app.use(express.json());

app.get("/", function (req, res) {
  res.json({ message: "Flash Sale API is working" });
});

// ---------- SIGNUP ----------
app.post("/signup", async function (req, res) {
  try {
    const body = req.body || {};
    const email = body.email;
    const password = body.password;

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const cleanEmail = email.trim().toLowerCase();

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(cleanEmail)) {
      return res.status(400).json({ error: "Please enter a valid email" });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({ error: "Password must be between 8 and 72 characters" });
    }

    const existingUser = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(cleanEmail);

    if (existingUser) {
      return res.status(409).json({ error: "This email is already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(cleanEmail, passwordHash);

    res.status(201).json({
      message: "Account created",
      user: { id: Number(result.lastInsertRowid), email: cleanEmail },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong on the server" });
  }
});

// login route
app.post("/login", async function (req, res) {
  try {
    const body = req.body || {};
    const email = body.email;
    const password = body.password;

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const cleanEmail = email.trim().toLowerCase();

    const user = db
      .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .get(cleanEmail);

    const hashToCheck = user ? user.password_hash : fakeHash;
    const passwordIsCorrect = await bcrypt.compare(password, hashToCheck);

    if (!user || !passwordIsCorrect) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ message: "Logged in", token: token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong on the server" });
  }
});

//MIDDLEWARE: check the token

function verifyToken(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
    req.user = payload;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please log in again" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

//products public routes

// Turn a product row from the database into what we send to the client
function formatProduct(product) {
  return {
    id: product.id,
    name: product.name,
    price: product.price / 100,          // 14999 cents -> 149.99
    stock: product.stock,
    status: product.stock > 0 ? "available" : "sold_out",
  };
}

// List all products
app.get("/products", function (req, res) {
  const products = db
    .prepare("SELECT id, name, price, stock FROM products ORDER BY id")
    .all();

  res.json({ products: products.map(formatProduct) });
});

// Get one product
app.get("/products/:id", function (req, res) {
  const id = Number(req.params.id);

  // The id in the URL must be a positive whole number
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  const product = db
    .prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
    .get(id);

  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  res.json({ product: formatProduct(product) });
});

//orders routes (login required)

const MAX_QUANTITY_PER_ORDER = 5; // stops one customer from buying everything

// Prepared queries (written once, used many times)
const findProduct = db.prepare("SELECT id, name, price, stock FROM products WHERE id = ?");

const findOrderByKey = db.prepare(
  "SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?"
);

const findOrderById = db.prepare("SELECT * FROM orders WHERE id = ?");

// check the stock and reduce it in a single step.
// It only changes the row if there is still enough stock.
const decreaseStock = db.prepare(
  "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"
);

const insertOrder = db.prepare(
  "INSERT INTO orders (user_id, product_id, quantity, total_price, idempotency_key) VALUES (?, ?, ?, ?, ?)"
);

// Turn an order row into what we send to the client
function formatOrder(order) {
  return {
    id: order.id,
    productId: order.product_id,
    quantity: order.quantity,
    totalPrice: order.total_price / 100,
    createdAt: order.created_at,
  };
}

// A transaction: everything inside succeeds together, or nothing is saved.
const createOrder = db.transaction(function (userId, productId, quantity, key) {
  // did this user already use this key? Then this is a retry.
  const existing = findOrderByKey.get(userId, key);

  if (existing) {
    const sameRequest = existing.product_id === productId && existing.quantity === quantity;
    if (sameRequest) {
      return { status: "duplicate", order: existing };
    }
    return { status: "key_conflict" };
  }

  // does the product exist?
  const product = findProduct.get(productId);

  if (!product) {
    return { status: "not_found" };
  }

  // try to take the units. "changes" is how many rows were updated.
  const update = decreaseStock.run(quantity, productId, quantity);

  if (update.changes === 0) {
    // The condition "stock >= quantity" was false: not enough units left
    return { status: "sold_out", available: product.stock };
  }

  // we got the units, so save the order
  const totalPrice = product.price * quantity;
  const result = insertOrder.run(userId, productId, quantity, totalPrice, key);
  const order = findOrderById.get(result.lastInsertRowid);

  return { status: "created", order: order };
});

// place an order (login required)
app.post("/orders", verifyToken, function (req, res) {
  const body = req.body || {};
  const productId = body.productId;
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  const key = req.headers["idempotency-key"];

  // check the Idempotency-Key header
  if (typeof key !== "string" || key.trim().length < 8 || key.trim().length > 100) {
    return res.status(400).json({
      error: "Idempotency-Key header is required (8 to 100 characters)",
    });
  }
  const cleanKey = key.trim();

  // check the product id and the quantity
  if (!Number.isInteger(productId) || productId < 1) {
    return res.status(400).json({ error: "productId must be a positive whole number" });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ORDER) {
    return res.status(400).json({
      error: "quantity must be a whole number between 1 and " + MAX_QUANTITY_PER_ORDER,
    });
  }

  try {
    // run the transaction
    const outcome = createOrder.immediate(req.user.id, productId, quantity, cleanKey);

    if (outcome.status === "not_found") {
      return res.status(404).json({ error: "Product not found" });
    }

    if (outcome.status === "key_conflict") {
      return res.status(422).json({
        error: "This Idempotency-Key was already used for a different request",
      });
    }

    if (outcome.status === "sold_out") {
      const message = outcome.available === 0
        ? "Sold out"
        : "Not enough stock, only " + outcome.available + " left";
      return res.status(409).json({ error: message });
    }

    if (outcome.status === "duplicate") {
      // Same request again, we send the original order, create nothing new
      return res.status(200).json({
        message: "Order already created (same request retried)",
        order: formatOrder(outcome.order),
      });
    }

    res.status(201).json({ message: "Order created", order: formatOrder(outcome.order) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong on the server" });
  }
});

// View costumor's orders (login required ofc)
app.get("/orders", verifyToken, function (req, res) {
  // JOIN adds the product name to each order
  const orders = db
    .prepare(`
      SELECT orders.id, orders.product_id, orders.quantity, orders.total_price,
             orders.created_at, products.name AS product_name
      FROM orders
      JOIN products ON products.id = orders.product_id
      WHERE orders.user_id = ?
      ORDER BY orders.id DESC
    `)
    .all(req.user.id);

  res.json({
    orders: orders.map(function (order) {
      return {
        id: order.id,
        productId: order.product_id,
        productName: order.product_name,
        quantity: order.quantity,
        totalPrice: order.total_price / 100,
        createdAt: order.created_at,
      };
    }),
  });
});

app.listen(PORT, function () {
  console.log("Server running on http://localhost:" + PORT);
});