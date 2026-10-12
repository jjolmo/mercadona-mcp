#!/usr/bin/env node
// CLI de mercadona-mcp. Todas las órdenes escriben JSON en stdout para que las pueda leer un agente.
import { parseCredentials, AuthError, ApiError } from "../src/client.mjs";
import * as shop from "../src/shop.mjs";

const HELP = `mercadona <orden> [opciones]

Sesión
  setup [--email <correo>]    Entra con email y contraseña (stdin, variables o $MERCADONA_HOME/.env)
  setup --paste               Lee por stdin el JSON de localStorage "MO-user" o un refresh token
  whoami | logout
  doctor                      Comprueba que todo está en regla (web, sesión, pedidos, carrito, entrega)

Catálogo
  search <texto> [--limit N]  Busca productos de tu zona
  product <id>

Carrito activo (el carrito o, si está vacío, un pedido que aún se puede modificar)
  status
  add <id> [cantidad]         Suma cantidad (en kg si el producto va a peso)
  set <id> <cantidad>         Fija la cantidad (0 la quita)
  remove <id>
  confirm                     Da por buenos los cambios; en un pedido hecho, los aplica
  discard                     Deshace los cambios sin confirmar
  cancel                      Vacía el carrito o descarta la edición del pedido

Historial
  orders [--limit N]
  suggest [--orders N] [--min-share 0.5]
  create [--orders N] [--min-share 0.5] [--replace]

Pago
  checkout [--slot <id>] [--address <id>]  Deja el pedido listo: dirección, tramos y total
  pay <checkout_id> --max <euros> --yes    Hace el pedido (irreversible)
`;

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opt[k] = true;
      else opt[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

async function stdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

const num = (v, d) => (v === undefined || v === true ? d : Number(String(v).replace(",", ".")));

async function run() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  switch (cmd) {
    case "setup": {
      if (opt.paste) {
        const text = await stdin();
        if (!text) throw new Error("Pega por stdin el valor de MO-user o el refresh token.");
        return shop.m.setCredentials(parseCredentials(text));
      }
      const email = opt.email || process.env.MERCADONA_EMAIL;
      if (!email) throw new Error("Falta --email (o MERCADONA_EMAIL en el .env, o usa --paste).");
      const password = process.env.MERCADONA_PASSWORD || (await stdin());
      if (!password) throw new Error("Pasa la contraseña por stdin o en MERCADONA_PASSWORD.");
      const { browserLogin } = await import("../src/login.mjs");
      return shop.m.setCredentials(await browserLogin(email, password));
    }
    case "whoami": {
      if (!shop.m.loggedIn) return { ok: false, logged_in: false };
      const me = await shop.m.getCustomer();
      return { ok: true, logged_in: true, customer_id: shop.m.customerId, name: me.name, email: me.email, warehouse: shop.m.session.warehouse };
    }
    case "doctor":
      return (await import("../src/doctor.mjs")).doctor();
    case "logout":
      shop.m.logout();
      return { ok: true };
    case "search":
      return shop.search(pos.join(" "), num(opt.limit, 8));
    case "product":
      return shop.product(await shop.m.getProduct(pos[0]));
    case "status":
      return shop.status();
    case "add":
      return shop.add(pos[0], num(pos[1], 1));
    case "set":
      return shop.setQuantity(pos[0], num(pos[1], 1));
    case "remove":
      return shop.remove(pos[0]);
    case "confirm":
      return shop.confirm();
    case "discard":
      return shop.discard();
    case "cancel":
      return shop.cancel();
    case "orders": {
      const data = await shop.m.getOrders(1);
      return (data.results || []).slice(0, num(opt.limit, 10)).map((o) => ({
        id: o.order_id ?? o.id,
        date: o.start_date ?? o.slot?.start,
        status: o.status_ui ?? o.status,
        total: o.summary?.total ?? o.price,
        products: o.products_count,
        changes_until: o.changes_until ?? null,
      }));
    }
    case "suggest":
      return shop.suggestFromHistory({ orders: num(opt.orders, 8), minShare: num(opt["min-share"], 0.5) });
    case "create":
      return shop.createFromHistory({ orders: num(opt.orders, 8), minShare: num(opt["min-share"], 0.5), replace: !!opt.replace });
    case "checkout":
      return shop.checkoutPrepare({ slotId: opt.slot, addressId: opt.address ? Number(opt.address) : undefined });
    case "pay":
      return shop.checkoutSubmit(pos[0], { yes: !!opt.yes, maxEur: num(opt.max, undefined) });
    default:
      process.stdout.write(HELP);
      return null;
  }
}

run()
  .then((out) => {
    if (out !== null) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  })
  .catch((e) => {
    const kind = e instanceof AuthError ? "auth" : e instanceof ApiError ? "api" : "error";
    process.stdout.write(JSON.stringify({ ok: false, kind, error: e.message, ...(e.body ? { detail: e.body } : {}) }, null, 2) + "\n");
    process.exit(1);
  });
