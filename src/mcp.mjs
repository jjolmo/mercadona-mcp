#!/usr/bin/env node
// Servidor MCP (stdio) con las mismas operaciones que el CLI.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as shop from "./shop.mjs";

const server = new McpServer({ name: "mercadona", version: "0.1.2" });

function tool(name, description, shape, fn) {
  server.tool(name, description, shape, async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(args ?? {}), null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message, detail: e.body ?? null }) }] };
    }
  });
}

tool("doctor", "Comprueba que todo está en regla: web, búsqueda, sesión, pedidos, carrito, dirección y tramos de entrega.",
  {}, async () => (await import("./doctor.mjs")).doctor());

tool("search_products", "Busca productos en la tienda de tu zona. Devuelve id, precio, si va a peso e imagen.",
  { query: z.string(), limit: z.number().int().min(1).max(30).optional() },
  ({ query, limit }) => shop.search(query, limit ?? 8));

tool("cart_status", "Estado del carrito activo: el carrito o, si está vacío, un pedido aún modificable. Incluye los cambios sin confirmar.",
  {}, () => shop.status());

tool("cart_add", "Suma una cantidad de un producto al carrito activo y comprueba que quedó guardado. No hace nada si no hay carrito ni pedido modificable.",
  { product_id: z.string(), quantity: z.number().positive().optional() },
  ({ product_id, quantity }) => shop.add(product_id, quantity ?? 1));

tool("cart_set", "Fija la cantidad de un producto en el carrito activo (0 lo quita).",
  { product_id: z.string(), quantity: z.number().min(0) },
  ({ product_id, quantity }) => shop.setQuantity(product_id, quantity));

tool("cart_confirm", "Da por buenos los cambios pendientes. En un pedido ya hecho es cuando se aplican de verdad. Llamar solo cuando el usuario lo diga.",
  {}, () => shop.confirm());

tool("cart_discard", "Deshace los cambios que aún no se han confirmado.", {}, () => shop.discard());

tool("cart_cancel", "Vacía el carrito, o descarta la edición si se estaba modificando un pedido. No anula pedidos.",
  {}, () => shop.cancel());

tool("cart_suggest", "Propone un carrito con lo que se repite en los últimos pedidos, sin tocar nada.",
  { orders: z.number().int().min(1).max(30).optional(), min_share: z.number().min(0).max(1).optional() },
  ({ orders, min_share }) => shop.suggestFromHistory({ orders, minShare: min_share }));

tool("cart_create_from_history", "Crea el carrito con lo que se repite en los últimos pedidos. Falla si ya hay carrito, salvo con replace.",
  { orders: z.number().int().min(1).max(30).optional(), min_share: z.number().min(0).max(1).optional(), replace: z.boolean().optional() },
  ({ orders, min_share, replace }) => shop.createFromHistory({ orders, minShare: min_share, replace }));

tool("checkout_prepare", "Deja el pedido listo para pagar: crea el checkout, elige dirección y, si se indica, el tramo de entrega.",
  { slot_id: z.string().optional(), address_id: z.number().int().optional() },
  ({ slot_id, address_id }) => shop.checkoutPrepare({ slotId: slot_id, addressId: address_id }));

tool("checkout_submit", "Hace el pedido de verdad (irreversible). Solo si el usuario lo pide expresamente; exige un tope en euros.",
  { checkout_id: z.string(), max_eur: z.number().positive(), confirm: z.literal(true) },
  ({ checkout_id, max_eur }) => shop.checkoutSubmit(checkout_id, { yes: true, maxEur: max_eur }));

await server.connect(new StdioServerTransport());
