// Cliente HTTP de la API interna de tienda.mercadona.es (no oficial).
// La sesión vive en $MERCADONA_HOME/session.json (por defecto ~/.config/mercadona-mcp), con permisos 0600.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE = "https://tienda.mercadona.es";
const API = `${BASE}/api`;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export const HOME = process.env.MERCADONA_HOME || join(homedir(), ".config", "mercadona-mcp");

// Credenciales opcionales en $MERCADONA_HOME/.env (MERCADONA_EMAIL, MERCADONA_PASSWORD): si están,
// la sesión se recupera sola cuando caduca. Las variables del entorno tienen prioridad.
(function loadEnv() {
  const p = join(HOME, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
})();

export const hasStoredLogin = () => !!(process.env.MERCADONA_EMAIL && process.env.MERCADONA_PASSWORD);

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function readJson(name, fallback = null) {
  const p = join(HOME, name);
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeJson(name, data, secret = false) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const p = join(HOME, name);
  writeFileSync(p, JSON.stringify(data, null, 2), { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(p, 0o600);
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** Acepta el JSON de localStorage "MO-user", un refresh token suelto o un objeto ya normalizado. */
export function parseCredentials(input) {
  const text = String(input).trim();
  if (!text.startsWith("{")) return { refresh_token: text };
  const o = JSON.parse(text);
  return {
    access_token: o.access_token ?? o.token ?? null,
    refresh_token: o.refresh_token ?? o.refreshToken ?? null,
    customer_id: o.customer_id ?? o.customer_uuid ?? o.uuid ?? null,
  };
}

export class Mercadona {
  constructor() {
    this.session = readJson("session.json", {});
    this.meta = readJson("web.json", {});
  }

  get customerId() {
    return this.session.customer_id;
  }

  get loggedIn() {
    return !!(this.session.refresh_token || this.session.access_token || hasStoredLogin());
  }

  saveSession() {
    writeJson("session.json", this.session, true);
  }

  async setCredentials(creds) {
    this.session = { ...this.session, ...Object.fromEntries(Object.entries(creds).filter(([, v]) => v)) };
    if (!this.session.access_token) await this.refresh();
    this.#learnCustomer();
    this.saveSession();
    const me = await this.getCustomer();
    return { customer_id: this.customerId, name: me.name, email: me.email, warehouse: this.session.warehouse };
  }

  logout() {
    this.session = {};
    this.saveSession();
  }

  #learnCustomer() {
    const c = jwtClaims(this.session.access_token || "");
    if (!this.session.customer_id) this.session.customer_id = c.customer_uuid ?? c.uuid ?? c.customer_id ?? null;
    if (c.exp) this.session.expires_at = c.exp;
  }

  /** El refresh token no necesita captcha y Mercadona puede rotarlo: siempre se guarda el nuevo. */
  async refresh() {
    const res = this.session.refresh_token
      ? await fetch(`${API}/auth/tokens/`, {
          method: "POST",
          headers: this.#headers(false),
          body: JSON.stringify({ refresh_token: this.session.refresh_token }),
        })
      : null;
    if (!res?.ok) {
      if (hasStoredLogin()) return this.relogin();
      if (!res) throw new AuthError("Sin sesión: falta el refresh token. Ejecuta `mercadona setup`.");
      throw new AuthError(`La sesión ha caducado (${res.status}). Vuelve a ejecutar \`mercadona setup\`.`);
    }
    const tok = await res.json();
    this.session.access_token = tok.access_token;
    if (tok.refresh_token) this.session.refresh_token = tok.refresh_token;
    if (tok.customer_id || tok.customer_uuid) this.session.customer_id = tok.customer_uuid ?? tok.customer_id;
    this.#learnCustomer();
    this.saveSession();
  }

  /** Entra de nuevo con las credenciales del .env (abre Chrome sin ventana por el captcha). */
  async relogin() {
    const { browserLogin } = await import("./login.mjs");
    const tok = await browserLogin(process.env.MERCADONA_EMAIL, process.env.MERCADONA_PASSWORD);
    this.session = { ...this.session, ...Object.fromEntries(Object.entries(tok).filter(([, v]) => v)) };
    this.#learnCustomer();
    this.saveSession();
  }

  #headers(auth) {
    const h = {
      accept: "application/json",
      "accept-language": "es-ES,es;q=0.9",
      "content-type": "application/json",
      "user-agent": UA,
      origin: BASE,
      referer: `${BASE}/`,
    };
    if (this.meta.version) h["x-version"] = this.meta.version;
    if (auth && this.session.access_token) h.authorization = `Bearer ${this.session.access_token}`;
    return h;
  }

  async request(method, path, body, { auth = true, retry = true } = {}) {
    if (auth && !this.session.access_token) await this.refresh();
    if (path.includes("/:me/")) {
      if (!this.customerId) throw new AuthError("Sin sesión. Ejecuta `mercadona setup`.");
      path = path.replace("/:me/", `/${this.customerId}/`);
    }
    const url = `${API}${path}${path.includes("?") ? "&" : "?"}lang=es${this.session.warehouse ? `&wh=${this.session.warehouse}` : ""}`;
    const res = await fetch(url, {
      method,
      headers: this.#headers(auth),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const wh = res.headers.get("x-customer-wh");
    if (wh && wh !== this.session.warehouse) {
      this.session.warehouse = wh;
      this.saveSession();
    }
    if (res.status === 401 && auth && retry) {
      await this.refresh();
      return this.request(method, path, body, { auth, retry: false });
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new ApiError(`${method} ${path} -> ${res.status}`, res.status, data);
    return data;
  }

  /** Ruta del cliente; el id se rellena en `request`, cuando ya hay sesión. */
  cust(suffix) {
    return `/customers/:me/${suffix}`;
  }

  getCustomer() { return this.request("GET", this.cust("")); }
  getCart() { return this.request("GET", this.cust("cart/")); }
  putCart(cart) { return this.request("PUT", this.cust("cart/"), cart); }
  getOrders(page = 1) { return this.request("GET", this.cust(`orders/?page=${page}`)); }
  getOrder(id) { return this.request("GET", this.cust(`orders/${id}/`)); }
  getOrderLines(id, page = 1) { return this.request("GET", this.cust(`orders/${id}/lines/prepared/?page=${page}`)); }
  getOrderCart(id) { return this.request("GET", this.cust(`orders/${id}/cart/`)); }
  getOrderDraft(id) { return this.request("GET", this.cust(`orders/${id}/cart/draft/`)); }
  putOrderDraft(id, cart) { return this.request("PUT", this.cust(`orders/${id}/cart/draft/`), { origin: "edit_order", ...cart }); }
  deleteOrderDraft(id) { return this.request("DELETE", this.cust(`orders/${id}/cart/draft/`)); }
  putOrderLines(id, lines, paymentMethodId) {
    return this.request("PUT", this.cust(`orders/${id}/lines/`), { lines, payment_method_id: paymentMethodId });
  }
  getAddresses() { return this.request("GET", this.cust("addresses/")); }
  getSlots(addressId) { return this.request("GET", this.cust(`addresses/${addressId}/slots/`)); }
  createCheckout(cart) { return this.request("POST", this.cust("checkouts/"), { cart }); }
  getCheckout(id) { return this.request("GET", this.cust(`checkouts/${id}/`)); }
  setCheckoutDelivery(id, addressId, slotId) {
    return this.request("PUT", this.cust(`checkouts/${id}/delivery-info/`), { address: { id: addressId }, slot: { id: slotId } });
  }
  submitCheckout(id) { return this.request("POST", this.cust(`checkouts/${id}/orders/`)); }
  getProduct(id) { return this.request("GET", `/products/${id}/`, undefined, { auth: false }); }
  getRegulars() { return this.request("GET", this.cust("recommendations/myregulars/precision/")); }

  /** Lee de la web el bundle actual: versión (cabecera x-version) y la clave pública de búsqueda de Algolia. */
  async discoverWeb() {
    const shell = await (await fetch(`${BASE}/`, { headers: { "user-agent": UA } })).text();
    const path = shell.match(/\/v\d+\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    if (!path) throw new Error("No encuentro el bundle de la web de Mercadona.");
    const js = await (await fetch(`${BASE}${path}`, { headers: { "user-agent": UA } })).text();
    const pair = js.match(/"([A-Z0-9]{10})",[A-Za-z0-9_$]+="([0-9a-f]{32})"/);
    if (!pair) throw new Error("No encuentro la configuración de búsqueda en la web de Mercadona.");
    this.meta = {
      version: path.match(/\/(v\d+)\//)[1],
      algolia_app: pair[1],
      algolia_key: pair[2],
      index_base: js.match(/"(products_prod[a-z_]*)"/)?.[1] ?? "products_prod",
      fetched_at: Date.now(),
    };
    writeJson("web.json", this.meta);
    return this.meta;
  }

  async search(query, limit = 10) {
    if (!this.meta.algolia_key || Date.now() - (this.meta.fetched_at ?? 0) > 7 * 86400e3) await this.discoverWeb();
    if (!this.session.warehouse && this.customerId) await this.getCustomer().catch(() => {});
    const wh = (this.session.warehouse || process.env.MERCADONA_WH || "mad1").toLowerCase();
    const res = await fetch(`https://${this.meta.algolia_app.toLowerCase()}-dsn.algolia.net/1/indexes/${this.meta.index_base}_${wh}_es/query`, {
      method: "POST",
      headers: {
        "X-Algolia-Application-Id": this.meta.algolia_app,
        "X-Algolia-API-Key": this.meta.algolia_key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=${limit}` }),
    });
    if (!res.ok) throw new Error(`Búsqueda -> ${res.status}`);
    return (await res.json()).hits ?? [];
  }
}
