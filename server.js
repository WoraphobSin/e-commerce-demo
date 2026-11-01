const http = require("node:http");
const {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} = require("node:crypto");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PRODUCTS_FILE = path.join(ROOT, "data", "products.json");
const ORDERS_FILE = path.join(ROOT, "data", "orders.json");
const USERS_FILE = path.join(ROOT, "data", "users.json");
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "sm_session";
const scryptAsync = promisify(scrypt);
const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, "[]\n");
}
const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
const sessions = new Map();
const loginAttempts = new Map();
let orderQueue = Promise.resolve();
let accountQueue = Promise.resolve();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function getSessionToken(request) {
  const cookie = request.headers.cookie || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`));
  return match ? match[1] : "";
}

function getAuthenticatedUser(request) {
  const token = getSessionToken(request);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash);
    return null;
  }
  return users.find((user) => user.id === session.userId) || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

function requestHasSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    return (
      (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
      parsedOrigin.host === request.headers.host
    );
  } catch {
    return false;
  }
}

function isRateLimited(request) {
  const now = Date.now();
  const key = request.socket.remoteAddress || "unknown";
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  current.count += 1;
  return current.count > 10;
}

function withAccountLock(operation) {
  const result = accountQueue.then(operation);
  accountQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function createSession(response, user) {
  const now = Date.now();
  for (const [tokenHash, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(tokenHash);
  }
  const token = randomBytes(32).toString("base64url");
  sessions.set(hashToken(token), { userId: user.id, expiresAt: now + SESSION_TTL_MS });
  setSessionCookie(response, token);
  return publicUser(user);
}

async function handleSignup(request, response) {
  if (isRateLimited(request)) {
    return sendJson(response, 429, { error: "Too many sign-in attempts. Please try again later." });
  }
  const payload = await readJsonBody(request);
  const name = payload && typeof payload.name === "string" ? payload.name.trim() : "";
  const email = payload && typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = payload && typeof payload.password === "string" ? payload.password : "";

  if (
    !name ||
    name.length > 80 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 10 ||
    password.length > 128
  ) {
    return sendJson(response, 400, {
      error: "Enter a name, valid email, and password between 10 and 128 characters.",
    });
  }

  const user = await withAccountLock(async () => {
    if (users.some((entry) => entry.email === email)) return null;
    const salt = randomBytes(16);
    const passwordHash = await scryptAsync(password, salt, 64);
    const newUser = {
      id: randomUUID(),
      name,
      email,
      passwordSalt: salt.toString("hex"),
      passwordHash: passwordHash.toString("hex"),
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    try {
      fs.writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`);
    } catch (error) {
      users.pop();
      throw error;
    }
    return newUser;
  });

  if (!user) {
    return sendJson(response, 409, { error: "An account with that email already exists." });
  }
  return sendJson(response, 201, { user: await createSession(response, user) });
}

async function handleLogin(request, response) {
  if (isRateLimited(request)) {
    return sendJson(response, 429, { error: "Too many sign-in attempts. Please try again later." });
  }
  const payload = await readJsonBody(request);
  const email = payload && typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = payload && typeof payload.password === "string" ? payload.password : "";
  if (password.length > 128) {
    return sendJson(response, 401, { error: "Email or password is incorrect." });
  }
  const user = users.find((entry) => entry.email === email);
  const salt = user ? Buffer.from(user.passwordSalt, "hex") : Buffer.alloc(16);
  const expectedHash = user ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(64);
  const providedHash = await scryptAsync(password.slice(0, 128), salt, 64);
  const validPassword =
    expectedHash.length === providedHash.length && timingSafeEqual(expectedHash, providedHash);

  if (!user || !validPassword) {
    return sendJson(response, 401, { error: "Email or password is incorrect." });
  }
  return sendJson(response, 200, { user: await createSession(response, user) });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function validateOrder(payload) {
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    return { error: "Your cart is empty." };
  }

  const customer = payload.customer;
  const requiredFields = ["name", "email", "address", "city", "postalCode", "country"];
  if (
    !customer ||
    requiredFields.some(
      (field) => typeof customer[field] !== "string" || customer[field].trim().length === 0
    )
  ) {
    return { error: "Please complete all delivery details." };
  }
  if (
    customer.name.trim().length > 100 ||
    customer.email.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim()) ||
    customer.address.trim().length > 200 ||
    customer.city.trim().length > 100 ||
    customer.postalCode.trim().length > 20 ||
    customer.country.trim().length > 100
  ) {
    return { error: "Please check your delivery details and try again." };
  }

  const quantities = new Map();
  for (const item of payload.items) {
    if (
      !item ||
      typeof item.productId !== "string" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10
    ) {
      return { error: "One or more cart items are invalid." };
    }
    const quantity = (quantities.get(item.productId) || 0) + item.quantity;
    if (quantity > 10) {
      return { error: "You can order up to 10 of each item." };
    }
    quantities.set(item.productId, quantity);
  }

  const items = [];
  for (const [productId, quantity] of quantities) {
    const product = products.find((entry) => entry.id === productId);
    if (!product) {
      return { error: "A product in your cart is no longer available." };
    }
    items.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity,
    });
  }

  return {
    customer: Object.fromEntries(
      requiredFields.map((field) => [field, customer[field].trim()])
    ),
    items,
    total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
  };
}

function saveOrder(order) {
  const write = orderQueue.then(async () => {
    const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
    orders.push(order);
    fs.writeFileSync(ORDERS_FILE, `${JSON.stringify(orders, null, 2)}\n`);
  });
  orderQueue = write.catch((error) => {
    console.error("Could not save order:", error);
  });
  return write;
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/products") {
    return sendJson(response, 200, { products });
  }
  if (request.method === "GET" && pathname === "/api/auth/me") {
    const user = getAuthenticatedUser(request);
    return sendJson(response, 200, { user: user ? publicUser(user) : null });
  }
  if (request.method === "POST" && pathname.startsWith("/api/auth/")) {
    if (!requestHasSameOrigin(request)) {
      return sendJson(response, 403, { error: "Request origin is not allowed." });
    }
    if (pathname === "/api/auth/signup") return handleSignup(request, response);
    if (pathname === "/api/auth/login") return handleLogin(request, response);
    if (pathname === "/api/auth/logout") {
      const token = getSessionToken(request);
      if (token) sessions.delete(hashToken(token));
      clearSessionCookie(response);
      return sendJson(response, 200, { user: null });
    }
  }
  if (request.method === "POST" && pathname === "/api/orders") {
    if (!requestHasSameOrigin(request)) {
      return sendJson(response, 403, { error: "Request origin is not allowed." });
    }
    const user = getAuthenticatedUser(request);
    if (!user) {
      return sendJson(response, 401, { error: "Sign in before placing an order." });
    }
    const payload = await readJsonBody(request);
    const result = validateOrder(payload);
    if (result.error) {
      return sendJson(response, 400, { error: result.error });
    }
    const order = {
      id: randomUUID(),
      userId: user.id,
      ...result,
      status: "payment_setup_required",
      createdAt: new Date().toISOString(),
    };
    await saveOrder(order);
    return sendJson(response, 201, {
      order: { id: order.id, total: order.total, status: order.status },
    });
  }
  return sendJson(response, 404, { error: "API route not found." });
}

function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end("Invalid URL.");
    return;
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(404);
    response.end("Not found.");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404);
      response.end("Not found.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
  );

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url.pathname);
    } catch (error) {
      console.error("Request failed:", error);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode ? error.message : "The request could not be completed.",
        });
      }
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed.");
    return;
  }
  serveStatic(request, response, url.pathname);
});

server.listen(PORT, () => {
  console.log(`S-Mall is running at http://localhost:${PORT}`);
});
