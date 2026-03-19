// Centralized API client with auth headers and auto-refresh

import { getToken, getRefreshToken, setAuth, clearAuth } from "./auth.js";
import { navigate } from "./router.js";

const API_BASE = "https://depix-backend.vercel.app";

/**
 * Authenticated fetch wrapper.
 * - Attaches Authorization header automatically
 * - On 401, attempts token refresh and retries once
 * - On refresh failure, clears auth and redirects to login
 *
 * @param {string} path — e.g. "/api/depix"
 * @param {object} [options] — fetch options (method, body, headers, etc.)
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Add device ID for rate limiting
  let deviceId = localStorage.getItem("depix-device-id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("depix-device-id", deviceId);
  }
  headers["X-Device-Id"] = deviceId;

  let res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  // If 401, try to refresh token
  if (res.status === 401 && token) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      // Retry with new token
      headers["Authorization"] = `Bearer ${getToken()}`;
      res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers
      });
    } else {
      clearAuth();
      navigate("#login");
      throw new Error("Sessão expirada. Faça login novamente.");
    }
  }

  return res;
}

/**
 * Try to refresh the access token using the refresh token.
 * @returns {Promise<boolean>} — true if refresh succeeded
 */
async function tryRefresh() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    });

    if (!res.ok) return false;

    const data = await res.json();
    if (data.token && data.refreshToken) {
      // Update tokens but keep existing user info
      const currentUser = JSON.parse(localStorage.getItem("depix-user") || "null");
      setAuth(data.token, data.refreshToken, currentUser);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
