const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const grid = document.querySelector("#product-grid");
const resultsCount = document.querySelector("#results-count");
const searchInput = document.querySelector("#search-input");
const sortSelect = document.querySelector("#sort-select");
const toast = document.querySelector("#toast");
const cartDialog = document.querySelector("#cart-dialog");
const productDialog = document.querySelector("#product-dialog");
const checkoutDialog = document.querySelector("#checkout-dialog");
const successDialog = document.querySelector("#success-dialog");
const authDialog = document.querySelector("#auth-dialog");

// These values hold the current shop state while the page is open.
let products = [];
let activeCategory = "All";
let cart = [];
let authUser = null;
let authMode = "login";
let pendingAddProductId = null;
let toastTimer;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

// Keep each signed-in customer's cart separate in this browser.
function loadCart(userId) {
  try {
    const saved = JSON.parse(localStorage.getItem(`s-mall-cart:${userId}`) || "[]");
    return Array.isArray(saved)
      ? saved.filter((item) => typeof item.productId === "string" && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10)
      : [];
  } catch {
    return [];
  }
}

function saveCart() {
  if (authUser) {
    localStorage.setItem(`s-mall-cart:${authUser.id}`, JSON.stringify(cart));
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

// Send a GraphQL operation and turn server-reported GraphQL errors into browser errors.
async function graphqlRequest(query, variables = {}) {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length) {
    throw new Error(result.errors?.[0]?.message || "The request could not be completed.");
  }
  return result.data;
}

// Apply the selected category, search text, and sort order to the product list.
function getVisibleProducts() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = products.filter((product) => {
    const matchesCategory = activeCategory === "All" || product.category === activeCategory;
    const matchesSearch = `${product.name} ${product.category} ${product.description}`.toLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  });
  const sort = sortSelect.value;
  if (sort === "price-low") visible.sort((a, b) => a.price - b.price);
  if (sort === "price-high") visible.sort((a, b) => b.price - a.price);
  if (sort === "name") visible.sort((a, b) => a.name.localeCompare(b.name));
  return visible;
}

// Build the product cards from server-provided catalog data.
function renderProducts() {
  const visible = getVisibleProducts();
  resultsCount.textContent = `${visible.length} ${visible.length === 1 ? "piece" : "pieces"}`;
  if (!visible.length) {
    grid.innerHTML = '<p class="empty-state">Nothing here just yet. Try another search or category.</p>';
    return;
  }
  grid.innerHTML = visible.map((product) => `
    <article class="product-card">
      <button class="product-image-button" type="button" data-product="${escapeHtml(product.id)}" aria-label="View ${escapeHtml(product.name)} details">
        <img class="product-image" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">
        ${product.badge ? `<span class="product-badge">${escapeHtml(product.badge)}</span>` : ""}
        <span class="quick-view">Quick view <span aria-hidden="true">↗</span></span>
      </button>
      <div class="product-meta"><span>${escapeHtml(product.category)}</span><span>${money.format(product.price)}</span></div>
      <div class="product-title-row">
        <button class="product-title" type="button" data-product="${escapeHtml(product.id)}">${escapeHtml(product.name)}</button>
        <button class="add-button" type="button" data-add="${escapeHtml(product.id)}" aria-label="Add ${escapeHtml(product.name)} to bag">+</button>
      </div>
    </article>
  `).join("");
}

// Join cart IDs with the catalog so displayed names and prices come from products.
function getCartLines() {
  return cart.map((entry) => {
    const product = products.find((item) => item.id === entry.productId);
    return product ? { ...product, quantity: entry.quantity } : null;
  }).filter(Boolean);
}

// Refresh the bag count, totals, and item list, then save the current user's cart.
function updateCart() {
  const lines = getCartLines();
  const quantity = lines.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = lines.reduce((sum, item) => sum + item.price * item.quantity, 0);
  document.querySelector(".bag-count").textContent = quantity;
  document.querySelector("#cart-title-count").textContent = `(${quantity})`;
  document.querySelector("#cart-subtotal").textContent = money.format(subtotal);
  document.querySelector("#checkout-total").textContent = money.format(subtotal);
  document.querySelector("#checkout-button").disabled = lines.length === 0;

  const container = document.querySelector("#cart-items");
  if (!lines.length) {
    container.innerHTML = '<div class="cart-empty"><span aria-hidden="true">✳</span><p>Your bag is taking a quiet moment.</p><button class="text-button" type="button" data-close-dialog>Discover something lovely</button></div>';
  } else {
    container.innerHTML = lines.map((item) => `
      <article class="cart-line">
        <img src="${escapeHtml(item.image)}" alt="">
        <div class="cart-line-info">
          <span class="cart-line-category">${escapeHtml(item.category)}</span>
          <h3>${escapeHtml(item.name)}</h3>
          <strong>${money.format(item.price)}</strong>
          <div class="quantity-control" aria-label="Quantity for ${escapeHtml(item.name)}">
            <button type="button" data-quantity="${escapeHtml(item.id)}" data-change="-1" aria-label="Remove one ${escapeHtml(item.name)}">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-quantity="${escapeHtml(item.id)}" data-change="1" aria-label="Add one ${escapeHtml(item.name)}">+</button>
          </div>
        </div>
        <button class="remove-button" type="button" data-remove="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name)} from bag">×</button>
      </article>
    `).join("");
  }
  saveCart();
}

// Ask the customer to sign in first, then add the selected item after authentication.
function addToCart(productId) {
  if (!authUser) {
    openAuth(productId);
    return;
  }
  const current = cart.find((item) => item.productId === productId);
  if (current && current.quantity >= 10) {
    showToast("The maximum quantity is 10.");
    return;
  }
  if (current) current.quantity += 1;
  else cart.push({ productId, quantity: 1 });
  updateCart();
  const product = products.find((item) => item.id === productId);
  showToast(`${product.name} added to your bag.`);
}

function openProduct(productId) {
  const product = products.find((item) => item.id === productId);
  if (!product) return;
  document.querySelector("#product-detail").innerHTML = `
    <img class="detail-image" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">
    <div class="detail-copy">
      <p class="eyebrow">${escapeHtml(product.category)}${product.badge ? ` · ${escapeHtml(product.badge)}` : ""}</p>
      <h2 id="product-dialog-title">${escapeHtml(product.name)}</h2>
      <p class="detail-price">${money.format(product.price)}</p>
      <p class="detail-description">${escapeHtml(product.description)}</p>
      <button class="button button-dark detail-add" type="button" data-add="${escapeHtml(product.id)}">Add to bag <span aria-hidden="true">↗</span></button>
      <p class="detail-footnote">Thoughtfully chosen. Made to be kept.</p>
    </div>
  `;
  productDialog.showModal();
}

// Remember a product addition while showing the sign-in/sign-up dialog.
function openAuth(productId = null) {
  pendingAddProductId = productId;
  if (productDialog.open) productDialog.close();
  if (cartDialog.open) cartDialog.close();
  authMode = "login";
  renderAuthMode();
  document.querySelector("#auth-error").textContent = "";
  authDialog.showModal();
}

// Switch the account form between login and registration fields and labels.
function renderAuthMode() {
  const isSignup = authMode === "signup";
  document.querySelector("#auth-title").textContent = isSignup ? "Create your account" : "Welcome back";
  document.querySelector("#auth-submit").textContent = isSignup ? "Create account" : "Sign in";
  document.querySelector("#auth-name-label").hidden = !isSignup;
  document.querySelector("#auth-name").required = isSignup;
  document.querySelector("#auth-password").autocomplete = isSignup ? "new-password" : "current-password";
  document.querySelector("#auth-switch-prompt").textContent = isSignup
    ? "Already have an account?"
    : "New to S-Mall?";
  document.querySelector("#auth-switch").textContent = isSignup ? "Sign in" : "Create an account";
}

// Send login or registration details to the API and update the browser after success.
async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = document.querySelector("#auth-submit");
  const errorMessage = document.querySelector("#auth-error");
  errorMessage.textContent = "";
  submitButton.disabled = true;
  submitButton.textContent = authMode === "signup" ? "Creating account…" : "Signing in…";

  const formData = new FormData(form);
  const payload = {
    email: formData.get("email"),
    password: formData.get("password"),
  };
  if (authMode === "signup") payload.name = formData.get("name");

  try {
    const operation = authMode === "signup"
      ? "mutation SignUp($input: SignupInput!) { signup(input: $input) { user { id name email } } }"
      : "mutation Login($input: LoginInput!) { login(input: $input) { user { id name email } } }";
    const data = await graphqlRequest(operation, { input: payload });
    authUser = data[authMode].user;
    cart = loadCart(authUser.id);
    updateCart();
    renderProducts();
    document.querySelector("#account-label").textContent = `Hi, ${authUser.name.split(/\s+/)[0]}`;
    authDialog.close();
    form.reset();

    const pendingProductId = pendingAddProductId;
    pendingAddProductId = null;
    if (pendingProductId) addToCart(pendingProductId);
    else showToast(`Signed in as ${authUser.email}.`);
  } catch (error) {
    errorMessage.textContent = error.message || "We couldn't sign you in. Please try again.";
  } finally {
    submitButton.disabled = false;
    renderAuthMode();
  }
}

// End the server session and clear account-specific cart data from the page.
async function logout() {
  try {
    await graphqlRequest("mutation Logout { logout }");
    authUser = null;
    cart = [];
    pendingAddProductId = null;
    document.querySelector("#account-label").textContent = "Sign in";
    renderProducts();
    updateCart();
    showToast("You have been signed out.");
  } catch (error) {
    showToast(error.message || "We couldn't sign you out.");
  }
}

// Submit delivery details and cart item IDs; the server checks prices and saves the order.
async function submitCheckout(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const errorMessage = document.querySelector("#checkout-error");
  errorMessage.textContent = "";
  button.disabled = true;
  button.textContent = "Saving your demo order…";
  const customer = Object.fromEntries(new FormData(form));

  try {
    const data = await graphqlRequest(
      `mutation CreateOrder($input: CreateOrderInput!) {
        createOrder(input: $input) { id total status }
      }`,
      {
        input: {
          customer,
          items: cart.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        },
      }
    );
    const order = data.createOrder;

    cart = [];
    updateCart();
    form.reset();
    checkoutDialog.close();
    cartDialog.close();
    document.querySelector("#success-message").textContent =
      `Demo order ${order.id.slice(0, 8).toUpperCase()} has been saved. Your total is ${money.format(order.total)}.`;
    successDialog.showModal();
  } catch (error) {
    errorMessage.textContent = error.message || "We couldn't save your order. Please try again.";
  } finally {
    button.disabled = false;
    button.innerHTML = 'Place demo order <span aria-hidden="true">↗</span>';
  }
}

// Handle clicks on product and cart controls, including controls rendered later.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const addButton = target.closest("[data-add]");
  const productButton = target.closest("[data-product]");
  const quantityButton = target.closest("[data-quantity]");
  const removeButton = target.closest("[data-remove]");
  const closeButton = target.closest("[data-close-dialog]");

  if (addButton) {
    addToCart(addButton.dataset.add);
    if (productDialog.open) productDialog.close();
  } else if (productButton) {
    openProduct(productButton.dataset.product);
  } else if (quantityButton) {
    const item = cart.find((entry) => entry.productId === quantityButton.dataset.quantity);
    if (!item) return;
    item.quantity += Number(quantityButton.dataset.change);
    if (item.quantity <= 0) cart = cart.filter((entry) => entry !== item);
    if (item.quantity > 10) item.quantity = 10;
    updateCart();
  } else if (removeButton) {
    cart = cart.filter((item) => item.productId !== removeButton.dataset.remove);
    updateCart();
  } else if (closeButton) {
    const dialog = closeButton.closest("dialog");
    if (dialog) dialog.close();
  }
});

document.querySelector(".bag-button").addEventListener("click", () => cartDialog.showModal());
document.querySelector("#account-button").addEventListener("click", () => {
  if (authUser) logout();
  else openAuth();
});
document.querySelector("#auth-form").addEventListener("submit", submitAuth);
document.querySelector("#auth-switch").addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  document.querySelector("#auth-error").textContent = "";
  renderAuthMode();
});
document.querySelector(".search-toggle").addEventListener("click", () => {
  document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
  searchInput.focus({ preventScroll: true });
});
document.querySelector("#checkout-button").addEventListener("click", () => {
  if (!getCartLines().length) return;
  cartDialog.close();
  const customerName = document.querySelector('#checkout-form [name="name"]');
  const customerEmail = document.querySelector('#checkout-form [name="email"]');
  if (authUser) {
    customerName.value = authUser.name;
    customerEmail.value = authUser.email;
  }
  checkoutDialog.showModal();
});
document.querySelector("#checkout-form").addEventListener("submit", submitCheckout);
searchInput.addEventListener("input", renderProducts);
sortSelect.addEventListener("change", renderProducts);
document.querySelectorAll(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => {
    activeCategory = button.dataset.category;
    document.querySelector(".filter-chip.is-active")?.classList.remove("is-active");
    button.classList.add("is-active");
    renderProducts();
  });
});
document.querySelector("#year").textContent = new Date().getFullYear();

document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});
authDialog.addEventListener("close", () => {
  pendingAddProductId = null;
});

// Load the catalog and login state together before displaying the store.
async function loadStore() {
  const data = await graphqlRequest(
    `query LoadStore {
      products { id name category price description image badge }
      me { id name email }
    }`
  );
  products = data.products;
  authUser = data.me;
  cart = authUser ? loadCart(authUser.id) : [];
  cart = cart.filter((item) => products.some((product) => product.id === item.productId));
  if (authUser) {
    document.querySelector("#account-label").textContent = `Hi, ${authUser.name.split(/\s+/)[0]}`;
  }
  renderProducts();
  updateCart();
}

loadStore().catch((error) => {
  resultsCount.textContent = error.message;
  showToast(error.message);
});
