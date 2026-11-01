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
const { buildSchema, graphql, GraphQLError } = require("graphql");

// Keep file locations and server settings together so the rest of the code can reuse them.
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
// Queue file writes so two requests don't overwrite each other's updates.
let orderQueue = Promise.resolve();
let accountQueue = Promise.resolve();

// Describe the data clients can request and the actions they can perform.
const schema = buildSchema(`
  type Product {
    id: ID!
    name: String!
    category: String!
    price: Int!
    description: String!
    image: String!
    badge: String!
  }

  type User {
    id: ID!
    name: String!
    email: String!
  }

  type AuthPayload {
    user: User!
  }

  type Order {
    id: ID!
    total: Int!
    status: String!
  }

  input SignupInput {
    name: String!
    email: String!
    password: String!
  }

  input LoginInput {
    email: String!
    password: String!
  }

  input CustomerInput {
    name: String!
    email: String!
    address: String!
    city: String!
    postalCode: String!
    country: String!
  }

  input OrderItemInput {
    productId: ID!
    quantity: Int!
  }

  input CreateOrderInput {
    customer: CustomerInput!
    items: [OrderItemInput!]!
  }

  type Query {
    products: [Product!]!
    me: User
  }

  type Mutation {
    signup(input: SignupInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
    logout: Boolean!
    createOrder(input: CreateOrderInput!): Order!
  }
`);

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

// Store only a hash of the session token in memory, not the original browser cookie value.
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

// Never send password hashes or salts back to the browser.
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

// Slow repeated signup/login attempts from the same IP address.
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

// Run account file updates one at a time to avoid duplicate accounts during concurrent signups.
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

// Validate a new account, hash its password, save it, and sign the customer in.
async function signupUser(input, request, response) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  if (
    !name ||
    name.length > 80 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 10 ||
    password.length > 128
  ) {
    throw new GraphQLError("Enter a name, valid email, and password between 10 and 128 characters.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (isRateLimited(request)) {
    throw new GraphQLError("Too many sign-in attempts. Please try again later.", {
      extensions: { code: "TOO_MANY_REQUESTS" },
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
    throw new GraphQLError("An account with that email already exists.", {
      extensions: { code: "ACCOUNT_EXISTS" },
    });
  }
  return { user: await createSession(response, user) };
}

// Check the submitted password against the stored hash and create a login session.
async function loginUser(input, request, response) {
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  if (isRateLimited(request)) {
    throw new GraphQLError("Too many sign-in attempts. Please try again later.", {
      extensions: { code: "TOO_MANY_REQUESTS" },
    });
  }
  if (password.length > 128) {
    throw new GraphQLError("Email or password is incorrect.", { extensions: { code: "UNAUTHENTICATED" } });
  }
  const user = users.find((entry) => entry.email === email);
  const salt = user ? Buffer.from(user.passwordSalt, "hex") : Buffer.alloc(16);
  const expectedHash = user ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(64);
  const providedHash = await scryptAsync(password.slice(0, 128), salt, 64);
  const validPassword =
    expectedHash.length === providedHash.length && timingSafeEqual(expectedHash, providedHash);

  if (!user || !validPassword) {
    throw new GraphQLError("Email or password is incorrect.", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return { user: await createSession(response, user) };
}

// Read the incoming request body and turn its JSON text into a JavaScript value.
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

// Check delivery details and cart quantities, then calculate prices from trusted catalog data.
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

// Append an order to local storage without losing another order being written at the same time.
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

// Map GraphQL query and mutation fields to the existing catalog, account, and order logic.
const rootValue = {
  products: () => products,
  me: (_args, context) => {
    const user = getAuthenticatedUser(context.request);
    return user ? publicUser(user) : null;
  },
  signup: async ({ input }, context) => {
    if (!requestHasSameOrigin(context.request)) {
      throw new GraphQLError("Request origin is not allowed.", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    return signupUser(input, context.request, context.response);
  },
  login: async ({ input }, context) => {
    if (!requestHasSameOrigin(context.request)) {
      throw new GraphQLError("Request origin is not allowed.", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    return loginUser(input, context.request, context.response);
  },
  logout: (_args, context) => {
    if (!requestHasSameOrigin(context.request)) {
      throw new GraphQLError("Request origin is not allowed.", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    const token = getSessionToken(context.request);
    if (token) sessions.delete(hashToken(token));
    clearSessionCookie(context.response);
    return true;
  },
  createOrder: async ({ input }, context) => {
    if (!requestHasSameOrigin(context.request)) {
      throw new GraphQLError("Request origin is not allowed.", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    const user = getAuthenticatedUser(context.request);
    if (!user) {
      throw new GraphQLError("Sign in before placing an order.", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    const result = validateOrder(input);
    if (result.error) {
      throw new GraphQLError(result.error, { extensions: { code: "BAD_USER_INPUT" } });
    }
    const order = {
      id: randomUUID(),
      userId: user.id,
      ...result,
      status: "payment_setup_required",
      createdAt: new Date().toISOString(),
    };
    await saveOrder(order);
    return { id: order.id, total: order.total, status: order.status };
  },
};

// Accept GraphQL JSON requests at one endpoint and return a GraphQL response object.
async function handleGraphql(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    return response.end("GraphQL requests must use POST.");
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    return sendJson(response, 415, {
      errors: [{ message: "GraphQL requests must use application/json." }],
    });
  }

  const payload = await readJsonBody(request);
  if (!payload || typeof payload.query !== "string") {
    return sendJson(response, 400, {
      errors: [{ message: "A GraphQL query string is required." }],
    });
  }

  const result = await graphql({
    schema,
    source: payload.query,
    rootValue,
    contextValue: { request, response },
    variableValues: payload.variables,
    operationName: payload.operationName,
  });
  const errors = result.errors?.map((error) => {
    if (error.originalError && !(error.originalError instanceof GraphQLError)) {
      console.error("GraphQL resolver failed:", error.originalError);
      return {
        message: "The request could not be completed.",
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      };
    }
    return {
      message: error.message,
      ...(error.extensions && Object.keys(error.extensions).length
        ? { extensions: error.extensions }
        : {}),
    };
  });
  const responseBody = {
    ...(Object.hasOwn(result, "data") ? { data: result.data } : {}),
    ...(errors?.length ? { errors } : {}),
  };
  const requestError = errors?.length && !Object.hasOwn(result, "data");
  return sendJson(response, requestError ? 400 : 200, responseBody);
}

// Serve website files from public/ and reject paths that try to leave that folder.
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

// The main request handler sends /graphql requests to the GraphQL API and other URLs to the file server.
const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
  );

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/graphql") {
    try {
      await handleGraphql(request, response);
    } catch (error) {
      console.error("Request failed:", error);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          errors: [{ message: error.statusCode ? error.message : "The request could not be completed." }],
        });
      }
    }
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    return sendJson(response, 404, { error: "REST API has been replaced by /graphql." });
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
