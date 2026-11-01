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

function getCartLines() {
  return cart.map((entry) => {
    const product = products.find((item) => item.id === entry.productId);
    return product ? { ...product, quantity: entry.quantity } : null;
  }).filter(Boolean);
}

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

function openAuth(productId = null) {
  pendingAddProductId = productId;
  if (productDialog.open) productDialog.close();
  if (cartDialog.open) cartDialog.close();
  authMode = "login";
  renderAuthMode();
  document.querySelector("#auth-error").textContent = "";
  authDialog.showModal();
}

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
    const response = await fetch(`/api/auth/${authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "We couldn't sign you in.");

    authUser = result.user;
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

async function logout() {
  try {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("We couldn't sign you out. Please try again.");
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
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer,
        items: cart.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "We couldn't save your order.");

    cart = [];
    updateCart();
    form.reset();
    checkoutDialog.close();
    cartDialog.close();
    document.querySelector("#success-message").textContent =
      `Demo order ${result.order.id.slice(0, 8).toUpperCase()} has been saved. Your total is ${money.format(result.order.total)}.`;
    successDialog.showModal();
  } catch (error) {
    errorMessage.textContent = error.message || "We couldn't save your order. Please try again.";
  } finally {
    button.disabled = false;
    button.innerHTML = 'Place demo order <span aria-hidden="true">↗</span>';
  }
}

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

async function loadStore() {
  const [productsResponse, authResponse] = await Promise.all([
    fetch("/api/products"),
    fetch("/api/auth/me"),
  ]);
  if (!productsResponse.ok) throw new Error("The collection could not be loaded.");
  if (!authResponse.ok) throw new Error("Your account status could not be checked.");
  const [productResult, authResult] = await Promise.all([
    productsResponse.json(),
    authResponse.json(),
  ]);
  products = productResult.products;
  authUser = authResult.user;
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
