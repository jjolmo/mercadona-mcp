# mercadona-mcp

Cliente no oficial de [tienda.mercadona.es](https://tienda.mercadona.es) para usar desde un agente
(Claude u otro), como **CLI** con salida JSON y como **servidor MCP**.

- Busca productos de tu zona.
- Crea el carrito con lo que sueles comprar: mira tus últimos pedidos y mete lo que se repite, con la cantidad típica.
- Mete, cambia o quita productos y **comprueba** releyendo el carrito que el cambio se ha guardado.
- Modifica un **pedido ya hecho** mientras Mercadona lo permita: los cambios van a un borrador y solo
  se aplican al confirmarlos.
- Lleva un registro de cambios pendientes que puedes confirmar o deshacer.
- Deja el pedido **listo para pagar** (dirección y tramo de entrega). Hacer el pedido exige una orden
  explícita y un tope en euros.

> Proyecto independiente, sin relación con Mercadona. Usa la misma API que su web, que puede cambiar
> sin aviso. Úsalo con moderación y solo con tu cuenta.

## Instalación

Requiere Node ≥ 18 y, para el primer inicio de sesión, Google Chrome o Chromium.

```bash
git clone https://github.com/jjolmo/mercadona-mcp.git
cd mercadona-mcp
npm install
```

## Inicio de sesión

La API pide un token de reCAPTCHA Enterprise al entrar con contraseña, y ese token solo lo da un
navegador. Después, la sesión se renueva sola con el *refresh token*, sin captcha. **La contraseña
no se guarda**; solo el refresh token, en `~/.config/mercadona-mcp/session.json` con permisos 0600
(puedes cambiar la carpeta con `MERCADONA_HOME`).

```bash
# Opción 1: email y contraseña. Abre Chrome sin ventana, pide el captcha a la web y entra.
printf '%s' 'tu-contraseña' | node bin/mercadona.mjs setup --email tu@correo.es

# Opción 2: con la sesión iniciada en tu navegador, en la consola de DevTools:
#   copy(localStorage.getItem('MO-user'))
# y pega el resultado:
pbpaste | node bin/mercadona.mjs setup --paste

node bin/mercadona.mjs whoami
```

Si Chrome no está en una ruta estándar, indícala con `CHROME_PATH`.

## CLI

```text
search <texto> [--limit N]       product <id>
status                           add <id> [cantidad]      set <id> <cantidad>      remove <id>
confirm                          discard                  cancel
orders [--limit N]               suggest [--orders N] [--min-share 0.5]
create [--orders N] [--min-share 0.5] [--replace]
checkout [--slot <id>] [--address <id>]
pay <checkout_id> --max <euros> --yes
```

### El carrito activo

Los cambios van al **carrito** si tiene algo. Si está vacío, van a un **pedido ya hecho** que todavía
se pueda modificar. Si no hay ninguno de los dos, `add` no hace nada y devuelve `reason: "no_cart"`.

Cada `add`, `set` o `remove` relee el carrito y devuelve `ok: true` solo si la cantidad guardada es la
esperada. Los cambios quedan como **pendientes** hasta que llamas a:

- `confirm`: en un pedido ya hecho, aplica el borrador al pedido. El banco puede pedir aprobar el
  nuevo importe. En el carrito normal solo los da por buenos.
- `discard`: deshace los cambios pendientes.

`cancel` vacía el carrito o descarta la edición de un pedido. No anula pedidos.

Los productos a peso (`selling_method` distinto de 0) se piden en kg.

## Servidor MCP

```json
{
  "mcpServers": {
    "mercadona": { "command": "node", "args": ["/ruta/a/mercadona-mcp/src/mcp.mjs"] }
  }
}
```

Herramientas: `search_products`, `cart_status`, `cart_add`, `cart_set`, `cart_confirm`, `cart_discard`,
`cart_cancel`, `cart_suggest`, `cart_create_from_history`, `checkout_prepare`, `checkout_submit`.

## Detalles de la API

- Autenticación: `POST /api/auth/tokens/` con `{username, password, recaptcha_token}` la primera vez y
  con `{refresh_token}` después. El refresh token puede rotar, y se guarda siempre el último.
- Carrito: `GET/PUT /api/customers/{id}/cart/`, con bloqueo optimista por `version`.
- Edición de pedidos: borrador en `PUT /api/customers/{id}/orders/{order}/cart/draft/` y aplicación
  con `PUT /api/customers/{id}/orders/{order}/lines/`.
- Búsqueda: el índice público de Algolia que usa la web. La clave de solo lectura y la versión de la
  web se leen en cada uso del propio bundle de tienda.mercadona.es; no van en el código.

## Licencia

MIT
