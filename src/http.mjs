/**
 * Shared HTTP for the API clients.
 *
 * Credentials go in headers, never in URLs: APIs echo request URLs in
 * their error messages, and a token in a query string ends up in logs. Every
 * string this module throws is passed through redact() first.
 */

const SECRET_ENV = /TOKEN|SECRET|KEY|PASSWORD/i;
const registered = new Set();

/** Treat a credential that did not come from the environment (e.g. `gh auth token`) as secret too. */
export function registerSecret(value) {
  if (value && String(value).length >= 8) registered.add(String(value));
}

/** Every credential value present in the environment, longest first. */
function secretValues() {
  return [
    ...registered,
    ...Object.entries(process.env)
      .filter(([k, v]) => SECRET_ENV.test(k) && v && v.length >= 8)
      .map(([, v]) => v),
  ].sort((a, b) => b.length - a.length);
}

/** Replace credential values and token-shaped strings in `text`. */
export function redact(text) {
  let s = String(text);
  for (const v of secretValues()) s = s.split(v).join('[redacted]');
  return s
    .replace(/(access_token|refresh_token|client_secret|token)=([^&\s"']+)/gi, '$1=[redacted]')
    .replace(/((?:Bearer|token)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]') // GitHub classic/OAuth/app tokens
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]'); // GitHub fine-grained tokens
}

export class ApiError extends Error {
  constructor(platform, status, body) {
    super(redact(`${platform} API ${status}: ${String(body).slice(0, 500)}`));
    this.platform = platform;
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch JSON with retries on 429/5xx. `fetchImpl` is injectable for tests.
 * With `withMeta`, resolves to { data, headers } so callers can read
 * rate-limit headers. `retryDelayMs` exists so tests do not wait.
 */
export async function getJson(platform, url, { headers = {}, method = 'GET', body, fetchImpl = globalThis.fetch, retries = 3, withMeta = false, retryDelayMs = 2000 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body });
    } catch (e) {
      last = new ApiError(platform, 'network', e.message);
      await sleep((retryDelayMs / 2) * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new ApiError(platform, res.status, `non-JSON response: ${text.slice(0, 200)}`);
      }
      return withMeta ? { data, headers: res.headers } : data;
    }
    last = new ApiError(platform, res.status, text);
    if (res.status !== 429 && res.status < 500) throw last;
    await sleep(retryDelayMs * 2 ** attempt);
  }
  throw last;
}

/** Read a required env var, with a setup hint instead of a stack trace. */
export function env(name, hint) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. ${hint}`);
  return v;
}
