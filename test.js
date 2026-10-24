// Concurrency test for the Flash Sale API
//
// Before running: delete shop.db, then start the server (npm run dev),
// so the products have their original stock.
// Run this file in a second terminal:  node test.js

const BASE = "http://localhost:3000";
const EMAIL = "tester@mail.com";
const PASSWORD = "mypassword123";


// Create the test user (if needed) and log in to get a token
async function getToken() {
  await fetch(BASE + "/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }); // if the user already exists we get 409, which is fine

  const res = await fetch(BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const data = await res.json();
  return data.token;
}

// Send one purchase request and return its status code
async function buy(token, productId, key) {
  const res = await fetch(BASE + "/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ productId: productId, quantity: 1 }),
  });
  return res.status;
}

// Turn [201, 409, 409, ...] into { 201: 1, 409: 2, ... }
function countStatuses(statuses) {
  const counts = {};
  for (const status of statuses) {
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

async function getStock(productId) {
  const res = await fetch(BASE + "/products/" + productId);
  const data = await res.json();
  return data.product.stock;
}

let failures = 0;

function check(description, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? "PASS" : "FAIL") + "  " + description + " (got " + actual + ", expected " + expected + ")");
}

//tests
async function main() {
  const token = await getToken();
  if (!token) {
    console.log("Could not log in. Is the server running?");
    return;
  }

  // test 1: 200 different purchases for a product with 10 units =====
  console.log("\nTest 1: 200 simultaneous orders for product 1 (10 units in stock)");

  const stockBefore1 = await getStock(1);
  console.log("Stock before: " + stockBefore1);

  const requests1 = [];
  for (let i = 0; i < 200; i++) {
    // every request has its own key, like 200 different customers
    requests1.push(buy(token, 1, "test1-" + Date.now() + "-" + i));
  }

  const statuses1 = await Promise.all(requests1); // all 200 are sent at the same time
  const counts1 = countStatuses(statuses1);
  const stockAfter1 = await getStock(1);

  console.log("Status codes:", counts1);
  console.log("Stock after: " + stockAfter1);

  check("orders created", counts1[201] || 0, stockBefore1);
  check("answered sold out", counts1[409] || 0, 200 - stockBefore1);
  check("stock after the sale", stockAfter1, 0);

  // test 2: the SAME request sent 20 times at once =====
  console.log("\nTest 2: the same request (same key) sent 20 times at once, product 2");

  const stockBefore2 = await getStock(2);
  console.log("Stock before: " + stockBefore2);

  const sameKey = "test2-" + Date.now();
  const requests2 = [];
  for (let i = 0; i < 20; i++) {
    requests2.push(buy(token, 2, sameKey));
  }

  const statuses2 = await Promise.all(requests2);
  const counts2 = countStatuses(statuses2);
  const stockAfter2 = await getStock(2);

  console.log("Status codes:", counts2);
  console.log("Stock after: " + stockAfter2);

  check("new orders created", counts2[201] || 0, 1);
  check("retries answered with the original order", counts2[200] || 0, 19);
  check("stock reduced only once", stockAfter2, stockBefore2 - 1);

  //results
  console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " CHECK(S) FAILED"));
}

main().catch(function (error) {
  console.log("Test crashed:", error.message);
});