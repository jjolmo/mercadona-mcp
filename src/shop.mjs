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

function summary(cart) {
  return {
    total: money(cart?.summary?.total ?? cart?.price ?? null),
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

/** Dónde van los cambios: el carrito si tiene algo, si no un pedido que aún se pueda modificar. */
export async function activeTarget() {
  const p = pending.get();
  if (p?.target?.type === "order") {
    const o = await m.getOrder(p.target.order_id).catch(() => null);
    if (o && isEditable(o)) return { type: "order", order: o };
  }
  const cart = await m.getCart();
  if (linesOf(cart).length) return { type: "cart", cart };
  const o = await editableOrder();
  if (o) return { type: "order", order: o };
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
  if (t.type === "cart") return m.putCart(body);
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
async function change(productId, fn) {
  const t = await activeTarget();
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
      total: money(check?.summary?.total),
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

export const add = (id, qty = 1) => change(id, (q) => q + qty);
export const setQuantity = (id, qty) => change(id, () => qty);
export const remove = (id) => change(id, () => 0);

/** Da por buenos los cambios. En un pedido ya hecho es cuando de verdad se aplican. */
export async function confirm() {
  const t = await activeTarget();
  const p = pending.get();
  if (t.type === "order") {
    const draft = await readTarget(t);
    const res = await m.putOrderLines(t.order.id, linesOf(draft).map(toWire), t.order.payment_method?.id);
    pending.clear();
    const sca = res?.authentication_mode;
    return {
      ok: true,
      target: describe(t),
      applied: p?.items ?? [],
      bank_approval: sca ? `El banco pide aprobar el cambio de importe (${sca}). Revísalo en la app de Mercadona o del banco.` : null,
      total: money(draft?.summary?.total),
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

/** Los productos que aparecen en al menos `minShare` de los últimos `orders` pedidos, con su cantidad típica. */
export async function suggestFromHistory({ orders = 8, minShare = 0.5 } = {}) {
  const picked = [];
  for (let page = 1; picked.length < orders && page <= 10; page++) {
    const data = await m.getOrders(page);
    for (const o of data.results || []) {
      const st = String(o.status_ui ?? o.status ?? "").toLowerCase();
      if (st.includes("cancel") || isEditable(o)) continue;
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
  if (!yes) return { ok: false, reason: "needs_yes", message: "Hacer el pedido es irreversible: repite con confirmación explícita." };
  const co = await m.getCheckout(checkoutId);
  const total = money(co.summary?.total);
  if (!maxEur || total === null || total > maxEur) {
    return { ok: false, reason: "over_budget", total, max: maxEur ?? null, message: "El total supera el tope (o no se pudo leer)." };
  }
  const res = await m.submitCheckout(checkoutId);
  return { ok: true, total, order: res };
}

export async function search(query, limit = 8) {
  return (await m.search(query, limit)).map(product);
}
