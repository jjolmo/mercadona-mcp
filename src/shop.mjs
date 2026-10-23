// Lógica de compra encima del cliente: un único "carrito activo", que es el carrito normal
// o el borrador de edición de un pedido ya hecho, y un diario de cambios pendientes de confirmar.
import { Mercadona, ApiError, readJson, writeJson } from "./client.mjs";

export const m = new Mercadona();

export function image(p, size = 600) {
  const src = p?.thumbnail || p?.photos?.[0]?.regular || p?.photos?.[0]?.zoom;
  return src ? `${src.split("?")[0]}?fit=crop&w=${size}&h=${size}` : null;
}

export function product(p) {
  if (!p) return null;
  const pi = p.price_instructions || {};
  return {
    id: String(p.id),
    name: p.display_name,
    packaging: p.packaging ?? null,
    price: pi.unit_price ? Number(pi.unit_price) : null,
    reference: pi.reference_price ? `${pi.reference_price} €/${pi.reference_format}` : null,
    // 0 = por unidades; con otro valor se vende a peso y la cantidad va en kg
    selling_method: pi.selling_method ?? 0,
    unit_size: pi.unit_size ?? null,
    size_format: pi.size_format ?? null,
    approx_size: pi.approx_size ?? null,
    min: pi.min_bunch_amount ?? null,
    step: pi.increment_bunch_amount ?? null,
    available: p.published !== false && !p.unavailable_from,
    image: image(p),
    url: p.share_url ?? null,
  };
}

function linesOf(cart) {
  return (cart?.lines || []).flatMap((l) => l.products ?? [l]);
}

function toWire(l) {
  const out = {
    product_id: String(l.product?.id ?? l.product_id),
    quantity: l.quantity,
    sources: l.sources ?? [],
  };
  const lineId = l.order_line_id ?? l.orderLineId ?? (l.product ? l.id : undefined);
  if (lineId !== undefined && lineId !== null) out.id = lineId;
  if (l.version) out.version = l.version;
  return out;
}

function money(v) {
  return v === undefined || v === null ? null : Number(v);
}

/** Los carritos de pedido no traen total: se suma precio × cantidad de cada línea. */
function cartTotal(cart) {
  const t = cart?.summary?.total;
  if (t !== undefined && t !== null) return money(t);
  const sum = linesOf(cart).reduce((acc, l) => {
    const pi = l.product?.price_instructions ?? l.original_price_instructions ?? {};
    const unit = Number(pi.selling_method ? pi.reference_price ?? pi.unit_price : pi.unit_price ?? 0);
    return acc + unit * Number(l.quantity ?? 0);
  }, 0);
  return Math.round(sum * 100) / 100;
}

function summary(cart) {
  return {
    total: cartTotal(cart),
    count: linesOf(cart).length,
    lines: linesOf(cart).map((l) => ({ ...product(l.product ?? {}), quantity: l.quantity })),
  };
}

// --- Pedidos editables -------------------------------------------------------

function isEditable(o) {
  const status = String(o.status_ui ?? o.status ?? "").toLowerCase();
  const until = o.changes_until ? Date.parse(o.changes_until) : 0;
  return status.includes("confirm") && until > Date.now();
}

export async function editableOrder() {
  const page = await m.getOrders(1);
  return (page.results || []).find(isEditable) ?? null;
}

// --- Carrito activo ----------------------------------------------------------

const pending = {
  get: () => readJson("pending.json", null),
  set: (p) => writeJson("pending.json", p),
  clear: () => writeJson("pending.json", null),
};

/** Dónde van los cambios: un pedido que aún se pueda modificar y, si no hay, el carrito si tiene algo. */
export async function activeTarget(only) {
  if (only === "cart") return { type: "cart", cart: await m.getCart() };
  const p = pending.get();
  if (p?.target?.type === "order") {
    const o = await m.getOrder(p.target.order_id).catch(() => null);
    if (o && isEditable(o)) return { type: "order", order: o };
  }
  const o = await editableOrder();
  if (o) return { type: "order", order: o };
  const cart = await m.getCart();
  if (linesOf(cart).length) return { type: "cart", cart };
  return { type: "none", cart };
}

async function readTarget(t) {
  if (t.type === "cart") return m.getCart();
  try {
    return await m.getOrderDraft(t.order.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return m.getOrderCart(t.order.id);
    throw e;
  }
}

async function writeTarget(t, base, lines) {
  const body = { id: base.id, ...(base.version ? { version: base.version } : {}), lines };
  // El id de línea solo existe en los pedidos; el carrito normal no lo lleva.
  if (t.type === "cart") return m.putCart({ ...body, lines: lines.map(({ id, ...l }) => l) });
  return m.putOrderDraft(t.order.id, body);
}

function describe(t) {
  if (t.type === "cart") return { type: "cart" };
  if (t.type === "order") {
    return {
      type: "order",
      order_id: t.order.id,
      delivery: t.order.slot?.start ?? t.order.start_date ?? null,
      changes_until: t.order.changes_until ?? null,
      order_total: money(t.order.summary?.total),
    };
  }
  return { type: "none" };
}

export async function status() {
  const t = await activeTarget();
  if (t.type === "none") return { target: describe(t), message: "No hay carrito ni pedido modificable." };
  const cart = await readTarget(t);
  return { target: describe(t), ...summary(cart), pending: pending.get()?.items ?? [] };
}

/** Cambia la cantidad de un producto y comprueba releyendo que el cambio quedó guardado. */
async function change(productId, fn, only) {
  const t = await activeTarget(only);
  if (t.type === "none") return { ok: false, reason: "no_cart", message: "No hay carrito ni pedido modificable: no se ha metido nada." };
  const id = String(productId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await readTarget(t);
    const lines = linesOf(base).map(toWire);
    const line = lines.find((l) => l.product_id === id);
    const before = line?.quantity ?? 0;
    const after = Math.max(0, fn(before));
    if (line) line.quantity = after;
    else if (after > 0) lines.push({ product_id: id, quantity: after, sources: [] });
    try {
      await writeTarget(t, base, lines.filter((l) => l.quantity > 0));
    } catch (e) {
      if (e instanceof ApiError && [409, 412].includes(e.status) && attempt === 0) continue;
      throw e;
    }
    const check = await readTarget(t);
    const now = linesOf(check).find((l) => String(l.product?.id ?? l.product_id) === id);
    const qty = now?.quantity ?? 0;
    const verified = Math.abs(qty - after) < 1e-6;
    const info = product(now?.product) ?? product(await m.getProduct(id));
    if (verified && after !== before) journal(t, info, after - before);
    return {
      ok: verified,
      reason: verified ? null : "not_verified",
      target: describe(t),
      product: info,
      before,
      quantity: qty,
      total: cartTotal(check),
    };
  }
  throw new Error("El carrito cambió a la vez desde otro sitio; vuelve a intentarlo.");
}

function journal(t, info, delta) {
  const p = pending.get() ?? { target: describe(t), items: [], since: new Date().toISOString() };
  const item = p.items.find((i) => i.product_id === info.id);
  if (item) item.delta += delta;
  else p.items.push({ product_id: info.id, name: info.name, delta, image: info.image });
  p.items = p.items.filter((i) => Math.abs(i.delta) > 1e-6);
  pending.set(p.items.length ? p : null);
}

// `only = "cart"` obliga a usar el carrito aunque haya un pedido modificable.
export const add = (id, qty = 1, only) => change(id, (q) => q + qty, only);
export const setQuantity = (id, qty, only) => change(id, () => qty, only);
export const remove = (id, only) => change(id, () => 0, only);

/** Da por buenos los cambios. En un pedido ya hecho es cuando de verdad se aplican. */
export async function confirm() {
  const t = await activeTarget();
  const p = pending.get();
  if (t.type === "order") {
    const draft = await readTarget(t);
    const wanted = new Map(linesOf(draft).map((l) => [String(l.product?.id ?? l.product_id), l.quantity]));
    const res = await m.putOrderLines(t.order.id, linesOf(draft).map(toWire), t.order.payment_method?.id);
    const { completeOrderAuth } = await import("./sca.mjs");
    const auth = await completeOrderAuth(m, t.order.id, res);
    // Solo vale si el pedido real tiene ya las cantidades del borrador.
    const now = await m.getOrderCart(t.order.id);
    const got = new Map(linesOf(now).map((l) => [String(l.product?.id ?? l.product_id), l.quantity]));
    const mismatches = [...new Set([...wanted.keys(), ...got.keys()])]
      .filter((id) => Math.abs((wanted.get(id) ?? 0) - (got.get(id) ?? 0)) > 1e-6);
    const applied = mismatches.length === 0;
    if (applied) pending.clear();
    const order = await m.getOrder(t.order.id);
    return {
      ok: applied,
      target: describe({ type: "order", order }),
      applied: applied ? p?.items ?? [] : [],
      bank_auth: auth,
      ...(applied ? {} : { reason: "not_applied", message: `El pedido no ha cambiado (autenticación del banco: ${auth}). Los cambios siguen pendientes.` }),
      order_total: money(order.summary?.total),
    };
  }
  pending.clear();
  return { ok: true, target: describe(t), applied: p?.items ?? [], note: "El carrito ya estaba guardado; no se ha hecho ningún pedido." };
}

/** Deshace los cambios que aún no se han confirmado. */
export async function discard() {
  const p = pending.get();
  if (!p) return { ok: true, undone: [] };
  const t = await activeTarget();
  if (t.type === "order") {
    await m.deleteOrderDraft(t.order.id).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
  } else if (t.type === "cart") {
    const base = await readTarget(t);
    const lines = linesOf(base).map(toWire);
    for (const i of p.items) {
      const l = lines.find((x) => x.product_id === i.product_id);
      if (l) l.quantity = Math.max(0, l.quantity - i.delta);
      else if (i.delta < 0) lines.push({ product_id: i.product_id, quantity: -i.delta, sources: [] });
    }
    await writeTarget(t, base, lines.filter((l) => l.quantity > 0));
  }
  pending.clear();
  return { ok: true, undone: p.items };
}

/** Vacía el carrito, o tira el borrador si se estaba modificando un pedido. Nunca anula un pedido. */
export async function cancel() {
  const t = await activeTarget();
  if (t.type === "none") return { ok: true, message: "No había carrito." };
  if (t.type === "order") {
    await m.deleteOrderDraft(t.order.id).catch(() => {});
    pending.clear();
    return { ok: true, target: describe(t), message: "Descartados los cambios del pedido. El pedido sigue en pie." };
  }
  const base = await m.getCart();
  await m.putCart({ id: base.id, version: base.version, lines: [] });
  pending.clear();
  const after = await m.getCart();
  return { ok: linesOf(after).length === 0, target: describe(t), removed: linesOf(base).length };
}

// --- Carrito a partir del historial ----------------------------------------------

async function allOrderLines(id) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await m.getOrderLines(id, page);
    out.push(...(data.results || []));
    if (!data.next_page || !(data.results || []).length) break;
  }
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Los productos que aparecen en al menos `minShare` de los últimos `orders` pedidos, con su cantidad típica.
 * Con 0,75 sale la compra "fija"; lo ocasional se añade aparte. Se ignoran pedidos de más de `maxAgeDays`.
 */
export async function suggestFromHistory({ orders = 8, minShare = 0.75, maxAgeDays = 365 } = {}) {
  const picked = [];
  for (let page = 1; picked.length < orders && page <= 10; page++) {
    const data = await m.getOrders(page);
    for (const o of data.results || []) {
      const st = String(o.status_ui ?? o.status ?? "").toLowerCase();
      if (st.includes("cancel") || isEditable(o)) continue;
      const when = Date.parse(o.start_date ?? o.slot?.start ?? "");
      if (when && Date.now() - when > maxAgeDays * 86400e3) continue;
      picked.push(o);
      if (picked.length >= orders) break;
    }
    if (!data.next_page) break;
  }
  if (!picked.length) return { orders: 0, items: [] };
  const stats = new Map();
  for (const o of picked) {
    for (const l of await allOrderLines(o.order_id ?? o.id)) {
      const p = l.product ?? {};
      const id = String(l.product_id ?? p.id);
      const s = stats.get(id) ?? { product: p, qty: [] };
      s.qty.push(Number(l.ordered_quantity ?? l.quantity ?? 1));
      stats.set(id, s);
    }
  }
  const items = [];
  for (const [id, s] of stats) {
    const share = s.qty.length / picked.length;
    if (share < minShare) continue;
    const info = product(s.product) ?? { id };
    const q = median(s.qty);
    const quantity = info.selling_method ? Math.round(q * 1000) / 1000 : Math.max(1, Math.round(q));
    items.push({ ...info, id, quantity, share: Math.round(share * 100) / 100 });
  }
  items.sort((a, b) => b.share - a.share || (a.name ?? "").localeCompare(b.name ?? ""));
  return {
    orders: picked.length,
    from: picked.at(-1)?.start_date ?? null,
    to: picked[0]?.start_date ?? null,
    items,
    estimated_total: Math.round(items.reduce((t, i) => t + (i.price ?? 0) * i.quantity, 0) * 100) / 100,
  };
}

export async function createFromHistory({ orders, minShare, replace = false } = {}) {
  const cart = await m.getCart();
  if (linesOf(cart).length && !replace) {
    return { ok: false, reason: "cart_exists", message: "Ya hay un carrito con cosas. Cancélalo antes o pide reemplazarlo.", ...summary(cart) };
  }
  const plan = await suggestFromHistory({ orders, minShare });
  const usable = plan.items.filter((i) => i.available !== false);
  await m.putCart({
    id: cart.id,
    version: cart.version,
    lines: usable.map((i) => ({ product_id: i.id, quantity: i.quantity, sources: [] })),
  });
  const after = await m.getCart();
  const s = summary(after);
  const p = { target: { type: "cart" }, items: s.lines.map((l) => ({ product_id: l.id, name: l.name, delta: l.quantity, image: l.image })), since: new Date().toISOString() };
  pending.set(p.items.length ? p : null);
  return {
    ok: s.count > 0,
    based_on_orders: plan.orders,
    skipped_unavailable: plan.items.filter((i) => i.available === false).map((i) => i.name),
    ...s,
  };
}

// --- Dejarlo listo para pagar ---------------------------------------------------

export async function checkoutPrepare({ slotId, addressId } = {}) {
  const cart = await m.getCart();
  if (!linesOf(cart).length) return { ok: false, reason: "empty_cart", message: "El carrito está vacío." };
  const checkout = await m.createCheckout({ id: cart.id, version: cart.version, lines: linesOf(cart).map(toWire) });
  const addresses = (await m.getAddresses()).results ?? [];
  const address = addresses.find((a) => a.id === addressId) ?? addresses.find((a) => a.is_default || a.default) ?? addresses[0];
  if (!address) return { ok: false, reason: "no_address", checkout_id: checkout.id };
  const slots = ((await m.getSlots(address.id)).results ?? []).filter((s) => s.available);
  const out = {
    ok: true,
    checkout_id: checkout.id,
    address: { id: address.id, text: [address.address, address.address_detail, address.postal_code, address.town].filter(Boolean).join(", ") },
    total: money(checkout.summary?.total ?? cart.summary?.total),
    slots: slots.slice(0, 12).map((s) => ({ id: s.id, start: s.start, end: s.end, price: money(s.price) })),
  };
  if (slotId) {
    const done = await m.setCheckoutDelivery(checkout.id, address.id, slotId);
    out.slot = slots.find((s) => String(s.id) === String(slotId)) ?? { id: slotId };
    out.total = money(done?.summary?.total ?? out.total);
    out.ready_to_pay = true;
  }
  return out;
}

/** Hace el pedido de verdad. Solo con `yes` y con un tope de gasto. */
export async function checkoutSubmit(checkoutId, { yes = false, maxEur } = {}) {
  if (!yes) return { ok: false, reason: "needs_yes", message: "Hacer el pedido cobra: repite con confirmación explícita." };
  const co = await m.getCheckout(checkoutId);
  const total = money(co.summary?.total);
  if (!maxEur || total === null || total > maxEur) {
    return { ok: false, reason: "over_budget", total, max: maxEur ?? null, message: "El total supera el tope (o no se pudo leer)." };
  }
  let res = await m.confirmCheckout(checkoutId);
  let auth = "not_required";
  if (res?.authentication_mode) {
    const { completeCheckoutAuth } = await import("./sca.mjs");
    auth = await completeCheckoutAuth(m, checkoutId, res);
    // Tras autenticar, la web vuelve a confirmar y entonces se crea el pedido; si no se autenticó, no sale order_id.
    res = await m.confirmCheckout(checkoutId).catch((e) => ({ error: e.body ?? e.message }));
  }
  const orderId = res?.order_id ?? null;
  if (!orderId) {
    return { ok: false, reason: "not_ordered", total, bank_auth: auth, detail: res,
      message: `No se ha hecho el pedido (autenticación del banco: ${auth}).` };
  }
  const order = await m.getOrder(orderId).catch(() => null);
  return { ok: true, total, bank_auth: auth, order_id: orderId, ...(order ? { target: describe({ type: "order", order }) } : {}) };
}

const plain = (html) => (html ? html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : null);

/** Ficha completa: ingredientes, alérgenos, conservación y las fotos (la de detrás suele ser la etiqueta). */
export async function details(id) {
  const p = await m.getProduct(id);
  const d = p.details || {};
  const n = p.nutrition_information || {};
  return {
    ...product(p),
    brand: p.brand ?? d.brand ?? null,
    origin: p.origin ?? d.origin ?? null,
    ingredients: plain(n.ingredients),
    allergens: plain(n.allergens),
    storage: d.storage_instructions || null,
    usage: d.usage_instructions || null,
    mandatory_mentions: d.mandatory_mentions || null,
    photos: (p.photos || []).map((f) => (f.zoom || f.regular).split("?")[0]),
  };
}

export async function search(query, limit = 8) {
  return (await m.search(query, limit)).map(product);
}

/** Lo que se suele comprar (`minShare` de los últimos pedidos) y no está en el carrito activo, o está en menor cantidad. */
export async function missing({ orders = 8, minShare = 0.5 } = {}) {
  const t = await activeTarget();
  const have = new Map();
  if (t.type !== "none") {
    for (const l of linesOf(await readTarget(t))) have.set(String(l.product?.id ?? l.product_id), l.quantity);
  }
  const plan = await suggestFromHistory({ orders, minShare });
  const out = { target: describe(t), orders: plan.orders, missing: [], fewer: [] };
  for (const i of plan.items) {
    const q = have.get(String(i.id));
    const item = { ...i, seen: Math.round(i.share * plan.orders) };
    if (q === undefined) out.missing.push(item);
    else if (q < i.quantity) out.fewer.push({ ...item, have: q });
  }
  return out;
}

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Cómo suele llamar Mercadona a cosas que se piden con otro nombre ("lechuga en bolsa" = ensalada lavada).
const SYN = { lechuga: ["ensalada", "lavada", "cogollo"], refresco: ["fresh gas"], cerveza: ["lager"], patata: ["patatas"] };
const STOP = new Set(["de", "del", "la", "el", "los", "las", "en", "con", "sin", "y", "a", "al", "un", "una", "para", "bolsa", "paquete", "pack"]);

/**
 * Productos de pedidos anteriores (incluido el abierto) cuyo nombre se parece a `query`, para repetir
 * lo que ya se compró antes de buscar en el catálogo. Ordena por palabras que coinciden y por veces comprado.
 */
export async function bought(query, { orders = 30 } = {}) {
  const words = norm(query).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length) return { query, orders: 0, items: [] };
  const stem = (w) => w.replace(/(es|s)$/, "");
  const picked = [];
  for (let page = 1; picked.length < orders && page <= 10; page++) {
    const data = await m.getOrders(page);
    for (const o of data.results || []) {
      if (String(o.status_ui ?? o.status ?? "").toLowerCase().includes("cancel")) continue;
      picked.push(o);
      if (picked.length >= orders) break;
    }
    if (!data.next_page) break;
  }
  const stats = new Map();
  for (const o of picked) {
    const date = o.start_date ?? o.slot?.start ?? null;
    for (const l of await allOrderLines(o.order_id ?? o.id)) {
      const p = l.product ?? {};
      const name = norm(p.display_name ?? p.name);
      const score = words.filter((w) => [stem(w), ...(SYN[stem(w)] ?? [])].some((v) => name.includes(v))).length;
      if (!score) continue;
      const id = String(l.product_id ?? p.id);
      const s = stats.get(id) ?? { product: p, score, times: 0, qty: [], last: null };
      s.times++;
      s.qty.push(Number(l.ordered_quantity ?? l.quantity ?? 1));
      if (date && (!s.last || date > s.last)) s.last = date;
      stats.set(id, s);
    }
  }
  const items = [...stats].map(([id, s]) => ({
    ...(product(s.product) ?? { id }), id, times: s.times, quantity: median(s.qty), last: s.last, match: s.score / words.length,
  }));
  items.sort((a, b) => b.match - a.match || b.times - a.times || String(b.last).localeCompare(String(a.last)));
  return { query, orders: picked.length, items: items.slice(0, 8) };
}
