// Comprueba paso a paso que todo lo necesario funciona y, si algo falla, dice cómo arreglarlo.
// Solo lee: no toca el carrito ni los pedidos.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, readJson } from "./client.mjs";
import { m, product } from "./shop.mjs";

const CHROMES = [process.env.CHROME_PATH, "/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);

export async function doctor() {
  const checks = [];
  const add = (id, status, detail, fix = null) => checks.push({ id, status, detail, ...(fix ? { fix } : {}) });
  const step = async (id, fn, fix) => {
    try {
      const r = await fn();
      add(id, r?.status ?? "ok", r?.detail ?? r, r?.fix ?? null);
      return r?.status !== "fail";
    } catch (e) {
      add(id, "fail", e.message, fix);
      return false;
    }
  };

  // --- Entorno ---
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 18 ? "ok" : "fail", `Node ${process.versions.node}`, major >= 18 ? null : "Instala Node 18 o superior.");
  await step("dependencias", async () => {
    await import("@modelcontextprotocol/sdk/server/mcp.js");
    return "dependencias instaladas";
  }, "Ejecuta `npm install` en la carpeta del proyecto.");
  let puppeteer = true;
  try {
    await import("puppeteer-core");
  } catch {
    puppeteer = false;
  }
  const chrome = CHROMES.find((p) => existsSync(p));
  add("navegador", puppeteer && chrome ? "ok" : "warn",
    puppeteer && chrome ? `Chrome en ${chrome}` : "Sin Chrome o sin puppeteer-core: no podrás entrar con email y contraseña.",
    puppeteer && chrome ? null : "Instala Google Chrome (o define CHROME_PATH) y ejecuta `npm install`; o usa `setup --paste`.");

  // --- Web pública ---
  const webOk = await step("web", async () => {
    const meta = await m.discoverWeb();
    return `tienda.mercadona.es responde (versión ${meta.version})`;
  }, "Revisa la conexión a internet. Si la web ha cambiado, puede hacer falta actualizar el proyecto.");
  if (webOk) {
    await step("búsqueda", async () => {
      const hits = await m.search("leche", 1);
      if (!hits.length) return { status: "warn", detail: "La búsqueda no devuelve resultados." };
      return `búsqueda OK («${product(hits[0]).name}»)`;
    }, "La búsqueda de la web ha cambiado; hace falta actualizar el proyecto.");
  }

  // --- Sesión ---
  const sessionFile = join(HOME, "session.json");
  if (!m.loggedIn) {
    add("sesión", "fail", `No hay sesión guardada (${sessionFile}).`, "Ejecuta `mercadona setup --email <correo>` o `setup --paste`.");
    return finish(checks);
  }
  const authOk = await step("sesión", async () => {
    await m.refresh();
    const days = m.session.expires_at ? Math.round((m.session.expires_at * 1000 - Date.now()) / 86400e3) : null;
    return `sesión renovada${days !== null ? ` (el acceso dura ${days} días y se renueva solo)` : ""}`;
  }, "La sesión ha caducado o se cerró: repite `mercadona setup`.");
  if (!authOk) return finish(checks);

  await step("cuenta", async () => {
    const me = await m.getCustomer();
    const wh = m.session.warehouse;
    return {
      status: wh ? "ok" : "warn",
      detail: `${me.name ?? "cliente"} · código postal ${me.current_postal_code ?? "?"} · almacén ${wh ?? "desconocido"}`,
      fix: wh ? null : "Sin almacén, los precios y la búsqueda pueden no ser los de tu zona.",
    };
  });

  // --- Historial ---
  let orders = [];
  const ordersOk = await step("pedidos", async () => {
    const page = await m.getOrders(1);
    orders = page.results || [];
    if (!orders.length) {
      return { status: "warn", detail: "La cuenta no tiene pedidos.", fix: "Sin pedidos no se puede crear el carrito a partir del historial." };
    }
    const last = orders[0];
    return `${page.count ?? orders.length} pedidos; el último, ${(last.start_date ?? last.slot?.start ?? "").slice(0, 10)} (${last.status_ui ?? last.status})`;
  });
  if (ordersOk && orders.length) {
    await step("líneas de pedido", async () => {
      const past = orders.find((o) => !String(o.status_ui ?? o.status).toLowerCase().includes("cancel")) ?? orders[0];
      const lines = (await m.getOrderLines(past.order_id ?? past.id)).results || [];
      if (!lines.length) return { status: "warn", detail: "El último pedido no devuelve productos." };
      return `se leen los productos de los pedidos (${lines.length} en el último)`;
    }, "No se pueden leer los productos de los pedidos: el historial no servirá para crear el carrito.");
    const statuses = [...new Set(orders.map((o) => `${o.status_ui ?? o.status}`))];
    const editable = orders.filter((o) => o.changes_until && Date.parse(o.changes_until) > Date.now());
    add("pedido modificable", "ok",
      editable.length
        ? `pedido ${editable[0].id} modificable hasta ${editable[0].changes_until}`
        : `ningún pedido modificable ahora (estados vistos: ${statuses.join(", ")})`);
  }

  // --- Carrito y entrega ---
  await step("carrito", async () => {
    const cart = await m.getCart();
    const n = (cart.lines || []).length;
    return `carrito accesible (${n} productos${cart.summary?.total ? `, ${cart.summary.total} €` : ""})`;
  }, "No se puede leer el carrito.");
  await step("dirección", async () => {
    const list = (await m.getAddresses()).results || [];
    if (!list.length) return { status: "warn", detail: "No hay direcciones guardadas.", fix: "Añade una dirección de entrega en la web o la app de Mercadona." };
    const a = list.find((x) => x.is_default || x.default) ?? list[0];
    const slots = ((await m.getSlots(a.id)).results || []).filter((s) => s.available);
    return {
      status: slots.length ? "ok" : "warn",
      detail: `${list.length} dirección(es); ${slots.length} tramos de entrega disponibles${slots[0] ? `, el primero ${slots[0].start}` : ""}`,
    };
  }, "No se pueden leer las direcciones o los tramos de entrega.");

  const pending = readJson("pending.json", null);
  if (pending?.items?.length) add("pendientes", "warn", `${pending.items.length} cambios sin confirmar`, "Confírmalos (`confirm`) o deshazlos (`discard`).");
  return finish(checks);
}

function finish(checks) {
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  return { ok: fail === 0, summary: fail ? `${fail} fallos, ${warn} avisos` : warn ? `todo funciona, ${warn} avisos` : "todo en regla", checks };
}
