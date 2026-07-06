/* ===========================================================================
   Adobe IMS token service for Document Authoring (DA). Runs on the HOST
   (imported by runner.mjs) — containers never see DA credentials (transport
   split).

   Exchanges the permanent service credentials (DA_CLIENT_ID, DA_CLIENT_SECRET,
   DA_SERVICE_TOKEN from app/.env) for a ~24h IMS access token, cached in
   memory with a 5-minute expiry buffer. This replaces the hand-copied personal
   DA_TOKEN that expired daily; DA_TOKEN still works as a legacy fallback when
   the service credentials are absent.
   =========================================================================== */

const IMS_TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";
const EXPIRY_BUFFER_MS = 300_000; // refresh 5 minutes before expiry

let cached = null; // { token, expiresAt }

/** True if the runner can mint (or fall back to) a DA token — used for the
 *  readiness check and the startup banner, without performing an exchange. */
export function daAuthConfigured() {
  const { DA_CLIENT_ID, DA_CLIENT_SECRET, DA_SERVICE_TOKEN, DA_TOKEN } = process.env;
  return !!((DA_CLIENT_ID && DA_CLIENT_SECRET && DA_SERVICE_TOKEN) || DA_TOKEN);
}

/** A valid DA bearer token: the cached IMS token while fresh, a new exchange
 *  otherwise. Throws with the IMS status + body when the exchange fails. */
export async function getDaToken() {
  if (cached && Date.now() < cached.expiresAt - EXPIRY_BUFFER_MS) return cached.token;

  const { DA_CLIENT_ID, DA_CLIENT_SECRET, DA_SERVICE_TOKEN, DA_TOKEN } = process.env;
  if (!(DA_CLIENT_ID && DA_CLIENT_SECRET && DA_SERVICE_TOKEN)) {
    if (DA_TOKEN) return DA_TOKEN; // legacy manual token — expires daily, avoid
    throw new Error("DA auth not configured: set DA_CLIENT_ID/DA_CLIENT_SECRET/DA_SERVICE_TOKEN (or legacy DA_TOKEN) in app/.env");
  }

  const res = await fetch(IMS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: DA_CLIENT_ID,
      client_secret: DA_CLIENT_SECRET,
      code: DA_SERVICE_TOKEN,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`IMS token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("IMS token exchange returned no access_token");
  const expiresIn = Number(data.expires_in) || 82_800; // default 23h
  cached = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cached.token;
}
