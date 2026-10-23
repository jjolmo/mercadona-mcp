// Autenticación del banco (SCA) cuando un cambio de importe o un pedido nuevo la pide.
// - "redirection": se envía el formulario de la pasarela (Redsys) en Chrome sin ventana y se espera
//   a que vuelva a la URL de OK o KO. Con exención (p. ej. TRA) el banco aprueba sin pedir nada; si pide
//   aprobar en la app del banco, se espera mientras quede tiempo.
// - "rest": el banco notifica en su app; se consulta el estado hasta que termina.
import { existsSync } from "node:fs";
import { BASE } from "./client.mjs";

const CHROMES = [process.env.CHROME_PATH, "/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `base` es `orders/<id>` (cambiar un pedido) o `checkouts/<id>` (hacer uno nuevo).
async function waitStatus(m, base, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = await m.request("GET", m.cust(`${base}/status/`)).catch(() => null);
    if (s?.state && s.state !== "pending" && s.state !== "authenticating" && s.state !== "processing_authentication") return s.state;
    await sleep(3000);
  }
  return "timeout";
}

async function redirect(m, base, back, uuid, ms) {
  const ok = `${back}?sca=ok`;
  const ko = `${back}?sca=ko`;
  const auth = await m.request("GET",
    m.cust(`${base}/authentication/?authentication_uuid=${uuid}&ok_url=${encodeURIComponent(ok)}&ko_url=${encodeURIComponent(ko)}`));
  const { URL_Base: action, ...fields } = auth.params ?? {};
  if (!action) throw new Error("La pasarela de pago no ha devuelto adónde enviar la autenticación.");
  const puppeteer = (await import("puppeteer-core")).default;
  const executablePath = CHROMES.find((p) => existsSync(p));
  if (!executablePath) throw new Error("Hace falta Chrome para completar la autenticación del banco.");
  const browser = await puppeteer.launch({ executablePath, headless: "new", args: ["--no-sandbox", "--lang=es-ES"] });
  try {
    const page = await browser.newPage();
    const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    await page.setContent(`<form id="f" method="POST" action="${esc(action)}">${inputs}</form>`);
    await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => {}), page.evaluate(() => document.getElementById("f").submit())]);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const url = page.url();
      if (url.startsWith(ok)) return "succeeded";
      if (url.startsWith(ko)) return "failed";
      await sleep(1500);
    }
    return "timeout";
  } finally {
    await browser.close();
  }
}

async function complete(m, base, back, res) {
  const mode = res?.authentication_mode;
  if (!mode) return "not_required";
  const detail = await m.request("GET", m.cust(`${base}/authentication-detail/`)).catch(() => ({}));
  const ms = Math.max(30, Math.min(300, Number(detail.remaining_time ?? 240) - 10)) * 1000;
  if (mode === "rest") return waitStatus(m, base, ms);
  const state = await redirect(m, base, back, res.authentication_uuid, ms);
  return state === "succeeded" ? waitStatus(m, base, 20000).then((s) => (s === "timeout" ? state : s)) : state;
}

/** Completa la autenticación que pide `res` (respuesta de PUT .../lines/). Devuelve el estado final. */
export const completeOrderAuth = (m, orderId, res) =>
  complete(m, `orders/${orderId}`, `${BASE}/user-area/orders/${orderId}`, res);

/** Lo mismo al hacer un pedido nuevo (respuesta 202 de POST checkouts/<id>/confirm/). */
export const completeCheckoutAuth = (m, checkoutId, res) =>
  complete(m, `checkouts/${checkoutId}`, `${BASE}/checkout/${checkoutId}`, res);
