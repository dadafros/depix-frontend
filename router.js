// Hash-based router for vanilla JS SPA
// Maps hash routes (#login, #home, etc.) to show/hide <section data-view="xxx">

const routes = {};
let currentView = null;

/**
 * Register a route handler.
 * @param {string} hash — e.g. "#login"
 * @param {Function} [onShow] — called when this view becomes active
 */
export function route(hash, onShow) {
  routes[hash] = onShow || null;
}

/**
 * Navigate to a hash route.
 */
export function navigate(hash) {
  window.location.hash = hash;
}

/**
 * Get current view name (without #).
 */
export function getCurrentView() {
  return currentView;
}

function onHashChange() {
  const hash = window.location.hash || "#login";
  const viewName = hash.replace("#", "");

  // Hide all views
  document.querySelectorAll("section[data-view]").forEach(s => {
    s.classList.add("hidden");
  });

  // Show target view
  const target = document.querySelector(`section[data-view="${viewName}"]`);
  if (target) {
    target.classList.remove("hidden");
    currentView = viewName;
  }

  // Call route handler
  const handler = routes[hash];
  if (handler) handler();
}

/**
 * Initialize the router. Call once on app startup.
 */
export function initRouter() {
  window.addEventListener("hashchange", onHashChange);
  onHashChange();
}
