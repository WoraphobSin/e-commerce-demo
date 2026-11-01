# S-Mall

A responsive e-commerce storefront starter with a Node.js GraphQL API, product catalog, account registration and login, browser-persisted per-account cart, and local demo-order storage.

## Run locally

Requires Node.js 18 or newer.

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). For automatic server restarts during development, use `npm run dev`. Set the `PORT` environment variable to change the port.

## Included

- Product catalog with search, category filters, sorting, and quick-view details
- A GraphQL API at `POST /graphql` for product queries and account/order mutations
- Email/password sign-up, login, and logout; product additions and orders require a signed-in account
- Passwords hashed with Node.js `scrypt`; signed sessions use an HttpOnly, SameSite cookie
- Shopping bag with quantity controls, subtotal, and browser `localStorage` persistence scoped to each account
- Server-validated checkout that calculates prices from the catalog and saves delivery details and orders to `data/orders.json`
- Responsive, accessible storefront layout

## GraphQL API

The browser sends GraphQL operations to one endpoint, `/graphql`. A query reads data; a mutation changes data. For example, a product query can ask for exactly the fields it needs:

```graphql
query {
  products {
    id
    name
    price
  }
  me {
    name
    email
  }
}
```

The API also provides `signup`, `login`, `logout`, and `createOrder` mutations. GraphQL schema and resolver code live in `server.js`; browser requests are sent by the `graphqlRequest` helper in `public/app.js`.

## Local account storage

Accounts are stored in `data/users.json`; this file is git-ignored and contains password hashes, not plaintext passwords. Sessions are held in memory and expire after seven days; restarting the server logs everyone out. This JSON-file setup is for local development only and is not suitable for a public or multi-instance deployment.

## Payment and production notes

Checkout currently saves a **demo order only** with status `payment_setup_required`. It does not collect card details, take payment, reserve stock, calculate shipping or tax, or send an order confirmation. Connect a payment provider (for example, Stripe Checkout) on the server before accepting real orders. Keep provider secret keys in server-side environment variables and never in browser code.

The JSON order file may contain customer delivery details. Do not deploy this starter as-is for real customer data. A production launch needs a persistent database, durable distributed sessions, secure deployment behind HTTPS, account recovery and email verification, authentication rate limiting shared across instances, authorization for administration, inventory and shipping/tax rules, privacy/retention policies, monitoring, and payment webhooks.

Product images are loaded from Unsplash and require an internet connection.
