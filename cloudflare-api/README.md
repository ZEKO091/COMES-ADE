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

La base remota ya tiene aplicada la migración `0001_initial_schema.sql`.
