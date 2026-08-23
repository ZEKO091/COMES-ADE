# ComesADE Cloudflare API

Worker remoto de ComesADE conectado a Cloudflare D1.

## Recursos

- Worker: `comesade-api`
- URL: <https://comesade-api.kingfrianfrian16.workers.dev>
- D1: `comesade-db`
- D1 UUID: `9c8b5847-87df-4174-9403-189cf50bd570`
- Región primaria: `ENAM`

## Estado actual

- `GET /health` comprueba que el Worker puede consultar D1.
- `GET /v1` expone el estado base de la API y deja explícito que workspaces y notas siguen siendo locales.
- ComesADE guarda workspaces y notas localmente en el PC del usuario mediante `localStorage`.
- La app de escritorio consulta `GET /health` y `GET /v1` para mostrar estado de conexión y verificar estabilidad del Worker.
- El Worker no expone rutas remotas autenticadas de datos: workspaces y notas permanecen locales por diseño.

## PayPal Advanced Checkout

El Worker implementa el backend mínimo para PayPal Expanded/Advanced Checkout con PayPal JavaScript SDK y Orders v2:

- `GET /v1/paypal/config` devuelve el client ID público, moneda y producto configurado.
- `GET /v1/paypal/client-token` genera un client token para `CardFields`.
- `POST /v1/paypal/orders` crea una orden `CAPTURE`.
- `POST /v1/paypal/orders/:order_id/capture` captura una orden aprobada.

El navegador solo envía `product_id` opcional y `quantity`; el precio y la moneda se calculan en el Worker a partir de la configuración. La integración actual representa un único producto digital y un pago único. No incluye todavía suscripciones, reembolsos, webhooks, catálogo D1 ni persistencia de órdenes.

### Configuración local

Para `wrangler dev`, crea un archivo local ignorado por Git llamado `.dev.vars` dentro de `cloudflare-api`:

```dotenv
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_CURRENCY=USD
PAYPAL_CLIENT_ID=TU_CLIENT_ID_DE_SANDBOX
PAYPAL_CLIENT_SECRET=TU_CLIENT_SECRET_DE_SANDBOX
PAYPAL_PRODUCT_ID=comesade-license
PAYPAL_PRODUCT_NAME=ComesADE License
PAYPAL_PRODUCT_AMOUNT=10.00
PAYPAL_ALLOWED_ORIGINS=http://localhost:5173
```

`PAYPAL_ENVIRONMENT` acepta `sandbox` (predeterminado) o `live`. `PAYPAL_ALLOWED_ORIGINS` es opcional; si se omite, el CORS sigue abierto como en el contrato base (`*`). En producción conviene configurarlo con los orígenes reales del cliente.

Para producción, guarda las credenciales como secretos y configura el resto como variables seguras del entorno, sin escribirlas en `wrangler.jsonc` ni en el código:

```powershell
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
```

El client ID no se devuelve como secreto: PayPal lo necesita en el JavaScript SDK. El client secret solo se usa dentro del Worker para OAuth 2.0. Advanced Credit and Debit Card Payments debe estar habilitado en la app de PayPal Developer.

Los access tokens de OAuth y los client tokens se cachean en memoria del isolate, con margen de caducidad, para no repetir OAuth en cada petición. `GET /v1/paypal/config` se cachea unos 60 segundos. Si PayPal no está configurado, esas rutas fallan con `paypal_not_configured` y el resto de la API sigue disponible. Un cron cada 5 minutos refresca el token para que el primer usuario tras un isolate frío no pague el OAuth.

### Flujo del cliente

1. Carga `GET /v1/paypal/config` y el JavaScript SDK con `public_client_id`.
2. Carga `GET /v1/paypal/client-token` y pasa `client_token` como `data-client-token` al SDK cuando uses `CardFields`.
3. En `createOrder`, llama a `POST /v1/paypal/orders` y devuelve `id` a PayPal.
4. En `onApprove`, llama a `POST /v1/paypal/orders/{orderID}/capture` y verifica el estado de la captura antes de entregar la licencia o activar una funcionalidad.

Las rutas de pago están preparadas para ser invocadas por el SDK del navegador, pero la API actual todavía no tiene sesiones de cuenta ni una tabla de órdenes. CORS no es autenticación. Antes de cobrar en producción hay que vincular cada orden con una sesión/usuario autenticado, persistir su estado y procesar webhooks de PayPal para reconciliación.

Referencias oficiales: [Advanced Checkout](https://developer.paypal.com/platforms/checkout/advanced/integrate), [OAuth 2.0](https://developer.paypal.com/api/rest/authentication) y [Orders v2](https://developer.paypal.com/api/rest/integration/orders-api/).

## Suscripciones PayPal de Planes

La página de Planes (`https://usecomes.com/`) comparte D1 (`comesade-db`) con `comesade-api`. Tras un pago de PayPal:

- `POST /v1/billing/paypal/activate` (Pages) autentica al usuario, consulta la suscripción real en PayPal y guarda en D1 el tipo de plan (`starter` / `pro` / `advanced`), el estado y `next_billing_at`.
- `POST /v1/billing/paypal/webhook` (Pages) verifica la firma de PayPal y actualiza esos mismos campos en renovaciones, fallos de cobro y cancelaciones.
- `GET /v1/billing/status` en `comesade-api` (con Bearer) lee esa misma D1 y devuelve `has_access`, `subscription.plan_type`, `subscription.status` y `subscription.next_billing_at` a la cuenta y al escritorio.

La migración `0002_paypal_billing.sql` crea `paypal_subscription_details` y `paypal_webhook_events`, además de asegurar las tablas base de clientes y suscripciones. La activación y los webhooks usan OAuth servidor-a-servidor y no confían en un estado enviado por el navegador.

## Cupo de voz (text-to-speech / dictado)

Cada palabra cuenta como 1 token. El cupo se reinicia cuando PayPal registra un pago nuevo (`last_payment_at`); si aún no hay pago, se usa `start_time`.

| Plan | Tokens por pago |
| --- | ---: |
| Starter | 5.000 |
| Pro | 15.000 |
| Advanced | 50.000 |
| admin | sin límite |

- `GET /v1/speech/quota` (Bearer) devuelve `plan`, `limit`, `used`, `remaining` y `period_key`.
- `POST /v1/speech/transcribe` (Bearer, `multipart/form-data` con `audio` y `language` opcional) transcribe con Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`) y descuenta el cupo.
- `POST /v1/speech/consume` queda para descuentos manuales de texto; el dictado de escritorio usa `transcribe`.

La migración `0003_speech_quota.sql` crea `speech_usage`. El email debe coincidir con `subscriber_email` de PayPal o `customers.email`.

## Cupo de chats del agente

Cada envío al agente (un chat) cuenta como 1 petición semanal. No es el cupo de voz. El contador se reinicia cada lunes (semana ISO, UTC).

| Plan | Chats por semana |
| --- | ---: |
| Starter | 1.000 |
| Pro | 30.000 |
| Advanced | 100.000 |
| admin | sin límite |

- `GET /v1/messages/quota` (Bearer) devuelve `plan`, `limit`, `used`, `remaining` y `period_key`.
- `POST /v1/messages/consume` con `{ "count": 1 }` descuenta un chat. Responde `402` si no hay plan o se agotó el cupo.

La migración `0004_message_quota.sql` crea `message_usage`.

## Better Auth (D1)

La autenticación nueva de Better Auth vive en el Worker y usa **Cloudflare D1** (`comesade-db`) mediante Drizzle (`provider: "sqlite"`). Las tablas son `user`, `session`, `account` y `verification` (singular). Las tablas legacy `users` / `sessions` de `/v1/auth/*` no se tocan.

- Handler: `GET|POST /api/auth/*` (`auth.handler`).
- Métodos: email/contraseña. El plugin `bearer` permite `Authorization: Bearer` (escritorio Tauri).
- Cliente de escritorio: `src/auth-client.ts` con `baseURL` apuntando a este Worker.
- La web (Pages) inicia sesión con `POST /api/auth/sign-in/email` y crea cuenta con `POST /api/auth/sign-up/email`. Las rutas `/v1/auth/*` quedan como compatibilidad.

### Secretos

`BETTER_AUTH_SECRET` debe tener al menos 32 caracteres. En local, copia `cloudflare-api/.dev.vars.example` a `.dev.vars` y genera el valor con `openssl rand -base64 32` o `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. En producción:

```powershell
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put BETTER_AUTH_API_KEY
```

`BETTER_AUTH_API_KEY` es la clave de Better Auth Infrastructure (`dash()`). No va en `wrangler.jsonc`.

`BETTER_AUTH_URL` es la URL pública del Worker (`https://comesade-api.kingfrianfrian16.workers.dev`). En `wrangler dev` usa `http://127.0.0.1:8787` en `.dev.vars`.

La migración `0005_better_auth.sql` crea el esquema. `npx auth@latest migrate` no aplica en D1 (es para el adapter Kysely). Aquí se usa `npm run d1:migrate:local` / `d1:migrate:remote`.

En Pages hay que configurar `PAYPAL_CLIENT_SECRET` y `PAYPAL_WEBHOOK_ID` como secretos. El webhook de PayPal debe apuntar a la URL HTTPS pública de `/v1/billing/paypal/webhook`; `localhost` no puede recibir notificaciones de PayPal.

## Desarrollo

```powershell
npm install
npm run types
npm run d1:migrate:local
npm run typecheck
npm run dev
```

## Migraciones y despliegue

```powershell
npm run d1:migrate:remote
npm run deploy
```

La migración nueva se valida localmente con `npm run d1:migrate:local`. No se ejecuta una migración remota ni un deploy automáticamente.
