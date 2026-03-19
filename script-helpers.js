// Extracted helper functions from script.js for testability

/**
 * Show a toast notification at the bottom of the screen.
 * @param {string} text — message to display
 */
export function showToast(text) {
  const toast = document.getElementById("toast");
  toast.innerText = text;
  toast.classList.remove("hidden");
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, 2000);
}

/**
 * Set a message element's text and optional success styling.
 * @param {string} id — element ID
 * @param {string} text — message text
 * @param {boolean} isSuccess — toggle success class
 */
export function setMsg(id, text, isSuccess = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerText = text;
  el.classList.toggle("success", isSuccess);
}

/**
 * Navigate to the appropriate screen based on auth and address state.
 * Accepts dependencies for testability.
 * @param {object} deps
 * @param {() => boolean} deps.isLoggedIn
 * @param {() => boolean} deps.hasAddresses
 * @param {(hash: string) => void} deps.navigate
 */
export function goToAppropriateScreen({ isLoggedIn, hasAddresses, navigate }) {
  if (!isLoggedIn()) {
    navigate("#login");
    return;
  }
  if (hasAddresses()) {
    navigate("#home");
  } else {
    navigate("#no-address");
  }
}
