# Flash Sale API

A backend API for an online store running a limited-time flash sale. Customers can browse products, see the available stock, place orders and view their orders.

The API is built to stay correct when hundreds of customers try to buy the same product at the same moment:

- Stock never goes negative
- A product is never oversold
- Simultaneous requests are handled safely
- A clear message is returned when a product is sold out
- Retrying the same request never creates a second order

Built with Node.js, Express, SQLite, bcryptjs and jsonwebtoken.

## Setup

1. Install Node.js (LTS version).
2. Install the libraries:
   ```
   npm install
   ```
3. Create a `.env` file in the project root:
   ```
   PORT=3000
   JWT_SECRET=put_a_long_random_text_here
   ```
   You can generate a secret with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Start the server:
   ```
   npm start
   ```
   Or, to restart automatically on every change:
   ```
   npm run dev
   ```

The database file `shop.db` is created automatically the first time, with 5 sample products.

To reset the stock, stop the server, delete `shop.db` and start the server again.

## Endpoints

| Method | Route | Login needed | Description |
|---|---|---|---|
| POST | `/signup` | No | Create an account |
| POST | `/login` | No | Log in and get a token |
| GET | `/products` | No | List products with their stock |
| GET | `/products/:id` | No | Get one product |
| POST | `/orders` | Yes | Place an order |
| GET | `/orders` | Yes | List my orders |

Protected routes need this header:
```
Authorization: Bearer <your token>
```

### POST /signup and POST /login

Body:
```json
{ "email": "test@mail.com", "password": "mypassword123" }
```

Login response:
```json
{ "message": "Logged in", "token": "eyJhbGciOi..." }
```

### GET /products

```json
{
  "products": [
    { "id": 1, "name": "Wireless Headphones", "price": 149.99, "stock": 10, "status": "available" }
  ]
}
```

`status` is `available` or `sold_out`.

### POST /orders

Headers:
```
Authorization: Bearer <your token>
Idempotency-Key: <a unique value for each purchase attempt, 8 to 100 characters>
```

Body:
```json
{ "productId": 1, "quantity": 2 }
```

`quantity` is optional (default 1) and can be from 1 to 5.

| Status | Meaning |
|---|---|
| `201` | Order created |
| `200` | Same request retried: the original order is returned, nothing new is created |
| `400` | Missing or invalid input, or missing Idempotency-Key |
| `401` | Missing, invalid or expired token |
| `404` | Product not found |
| `409` | Sold out, or not enough stock |
| `422` | The Idempotency-Key was already used for a different request |

### GET /orders

Returns only the orders of the logged-in user, newest first.

## How overselling is prevented

A naive server reads the stock, checks it in code, then writes the new value. Two requests can both read "1 left" before either one writes, and both succeed. That is a race condition.

This API avoids it with three layers:

1. **Atomic update.** Checking and reducing the stock happens in one SQL statement:
   ```sql
   UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?
   ```
   If no row was changed, there was not enough stock, and the API answers "sold out".
2. **Transaction.** Reducing the stock and creating the order succeed or fail together, so a customer never loses a unit without getting an order.
3. **Database rule.** The `products` table has `CHECK (stock >= 0)`, so the database itself refuses a negative stock even if the code had a bug.

## How duplicate orders are prevented

Every order request must include an `Idempotency-Key` header, a unique value created by the client for each purchase attempt.

- First time the key is seen: the order is created.
- Same key, same product and quantity (a retry): the original order is returned and the stock is not touched.
- Same key, different product or quantity: rejected with `422`.

The key is checked inside the same transaction as the stock update. The table also has `UNIQUE (user_id, idempotency_key)`, so the database blocks duplicates even if two identical requests arrive at the same instant.

## Run the concurrency test

The file `test.js` sends many requests at once to prove the rules above.

1. Stop the server, delete `shop.db`, and start the server again (`npm run dev`).
2. In a second terminal, run:
   ```
   node test.js
   ```

What it checks:

| Test | Expected result |
|---|---|
| 200 simultaneous orders for a product with 10 units | Exactly 10 orders, 190 "sold out", stock ends at 0 |
| The same request (same key) sent 20 times at once | Exactly 1 order, 19 retries answered with the original order, stock reduced once |

Delete `shop.db` before every run, because the test uses up the stock.

## Security

- Passwords are hashed with bcrypt and are never stored or returned in plain text.
- Tokens are signed with a secret from the `.env` file and expire after 1 hour.
- Login returns the same error for a wrong email and a wrong password.
- SQL queries use placeholders, which protects against SQL injection.
- Users can only see their own orders. The user id comes from the verified token.
- Prices are stored in cents to avoid rounding errors.
- The `.env` file and the database are listed in `.gitignore`.

## Project files

| File | Role |
|---|---|
| `server.js` | Routes, middleware and server start |
| `database.js` | SQLite connection, tables and sample products |
| `test.js` | Concurrency test |
| `.env` | Secrets (not uploaded to Git) |
| `.gitignore` | Files that Git should ignore |