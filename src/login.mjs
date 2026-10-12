// Primer inicio de sesión: la API exige un token de reCAPTCHA Enterprise que solo da un navegador.
// Se abre Chrome sin ventana, se pide el token desde la propia web y se entra con email y contraseña.
// La contraseña no se guarda: solo el refresh token, que renueva la sesión sin captcha.
import { existsSync } from "node:fs";
import { BASE } from "./client.mjs";

const CHROMES = [
  process.env.CHROME_PATH,
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export async function browserLogin(email, password) {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch {
    throw new Error("Falta puppeteer-core (npm install). También puedes usar `mercadona setup --paste`.");
  }
  const executablePath = CHROMES.find((p) => existsSync(p));
  if (!executablePath) throw new Error("No encuentro Chrome. Indica la ruta con CHROME_PATH.");
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--lang=es-ES", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
    const res = await page.evaluate(
      async (email, password) => {
        const bundle = [...document.scripts].map((s) => s.src).find((s) => /\/index-[\w-]+\.js$/.test(s));
        const js = await (await fetch(bundle)).text();
        const key = js.match(/enterprise\.js\?render=(6L[\w-]{38})/)?.[1];
        if (!key) return { status: 0, body: { error: "No encuentro la clave de reCAPTCHA en la web." } };
        await new Promise((ok, ko) => {
          const s = document.createElement("script");
          s.src = `https://www.google.com/recaptcha/enterprise.js?render=${key}`;
          s.onload = ok;
          s.onerror = ko;
          document.head.appendChild(s);
        });
        await new Promise((r) => window.grecaptcha.enterprise.ready(r));
        const token = await window.grecaptcha.enterprise.execute(key, { action: "login" });
        const r = await fetch("/api/auth/tokens/?lang=es", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ username: email, password, recaptcha_token: token }),
        });
        let body = null;
        try {
          body = await r.json();
        } catch {}
        return { status: r.status, body };
      },
      email,
      password,
    );
    if (res.status === 200 && res.body?.refresh_token) {
      return {
        access_token: res.body.access_token,
        refresh_token: res.body.refresh_token,
        customer_id: res.body.customer_id ?? res.body.customer_uuid ?? null,
      };
    }
    if (res.status === 400) throw new Error("Email o contraseña incorrectos.");
    if (res.status === 412) throw new Error("Mercadona ha pedido un captcha visible. Usa `mercadona setup --paste`.");
    throw new Error(`No se pudo entrar (${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`);
  } finally {
    await browser.close();
  }
}
