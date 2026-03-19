// Address management — localStorage-based

const ADDRESSES_KEY = "depix-addresses";
const SELECTED_KEY = "depix-selected-address";

/**
 * Get all saved addresses.
 * @returns {string[]}
 */
export function getAddresses() {
  try {
    return JSON.parse(localStorage.getItem(ADDRESSES_KEY)) || [];
  } catch {
    return [];
  }
}

/**
 * Add an address. Returns false if duplicate.
 * @param {string} addr
 * @returns {boolean}
 */
export function addAddress(addr) {
  const addresses = getAddresses();
  const trimmed = addr.trim();
  if (!trimmed || addresses.includes(trimmed)) return false;
  addresses.push(trimmed);
  localStorage.setItem(ADDRESSES_KEY, JSON.stringify(addresses));

  // Auto-select if it's the first address
  if (addresses.length === 1) {
    setSelectedAddress(trimmed);
  }

  return true;
}

/**
 * Remove an address.
 * @param {string} addr
 */
export function removeAddress(addr) {
  const addresses = getAddresses().filter(a => a !== addr);
  localStorage.setItem(ADDRESSES_KEY, JSON.stringify(addresses));

  // Clear selection if the removed address was selected
  if (getSelectedAddress() === addr) {
    setSelectedAddress(addresses[0] || "");
  }
}

/**
 * Get the currently selected address.
 * @returns {string}
 */
export function getSelectedAddress() {
  return localStorage.getItem(SELECTED_KEY) || "";
}

/**
 * Set the selected address.
 * @param {string} addr
 */
export function setSelectedAddress(addr) {
  localStorage.setItem(SELECTED_KEY, addr);
}

/**
 * Abbreviate an address to industry standard format.
 * Example: "tlq1qqv2hf6y...9x3f8" (first 8 + ... + last 4)
 * @param {string} addr
 * @returns {string}
 */
export function abbreviateAddress(addr) {
  if (!addr || addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

/**
 * Check if user has any addresses saved.
 * @returns {boolean}
 */
export function hasAddresses() {
  return getAddresses().length > 0;
}
