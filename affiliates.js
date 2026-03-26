// Affiliate program helpers — extracted for testability

/**
 * Capture referral code from URL hash query params and store in sessionStorage.
 * @param {string} hash - window.location.hash value
 */
export function captureReferralCode(hash) {
  const params = new URLSearchParams((hash || "").split("?")[1] || "");
  const ref = params.get("ref");
  if (ref) sessionStorage.setItem("depix-ref", ref);
}

/**
 * Get stored referral code and build registration body with optional ref.
 * @param {object} fields - { nome, email, whatsapp, usuario, senha }
 * @returns {object} Registration body, with ref if present
 */
export function buildRegistrationBody(fields) {
  const ref = sessionStorage.getItem("depix-ref") || undefined;
  return { ...fields, ...(ref && { ref }) };
}

/**
 * Clear stored referral code after successful registration.
 */
export function clearReferralCode() {
  sessionStorage.removeItem("depix-ref");
}

/**
 * Build the affiliate link URL from a referral code.
 * @param {string} referralCode
 * @returns {string}
 */
export function buildAffiliateLink(referralCode) {
  return `https://depixapp.com/#landing?ref=${referralCode}`;
}

/**
 * Generate HTML for the referrals list.
 * @param {Array} referrals - array of { nome, monthlyVolumeCents, registeredAt }
 * @param {function} formatBRL - currency formatter
 * @param {function} formatDateShort - date formatter
 * @returns {{ html: string, isEmpty: boolean }}
 */
export function renderReferralsHTML(referrals, formatBRL, formatDateShort) {
  if (!referrals || referrals.length === 0) {
    return { html: "", isEmpty: true };
  }
  const html = referrals.map(r => `
    <div class="referral-item">
      <span class="referral-name">${r.nome}</span>
      <div class="referral-info">
        <span class="referral-volume">${formatBRL(r.monthlyVolumeCents)}</span>
        <span class="referral-date">Desde ${formatDateShort(r.registeredAt)}</span>
      </div>
    </div>
  `).join("");
  return { html, isEmpty: false };
}
