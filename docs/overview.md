# Project Overview

## Stack
- Node.js with Express for HTTP handling
- Middleware: morgan (logging), cookie-parser, dotenv, debug

## Structure
- `src/app.js` – Express app, middleware, routing
- `src/routes/` – Router entrypoints (`index.js`)
- `src/controllers/` – Request handlers (e.g., `healthController.js`)
- `bin/www` – HTTP server bootstrap (debug namespace `onpac-api:server`), used by npm scripts
- `.env.example` – Environment template

## Setup
1. Install deps: `npm install`
2. Env: copy `.env.example` to `.env`; adjust `PORT`, `DEBUG`
3. Run dev/local: `npm start` (or `npm run dev`) – starts via `bin/www`
   - Dev script uses `nodemon --legacy-watch` for WSL-friendly auto reloads.
4. Health check: `GET /health` → `{ "status": "ok" }`

## Logging
- HTTP logs via morgan (`dev` format)
- Debug namespaces: `app:*` for middleware/controllers, `onpac-api:server` for server bootstrap
- Enable with `DEBUG=app:*,onpac-api:server`

## Change Review Checklist
- [ ] Routes/controllers documented here when added/changed
- [ ] Env vars updated in `.env.example` and noted above
- [ ] Server entry (`bin/www`) kept in sync with deployment expectations (PM2/cron)
- [ ] Add tests or manual steps for new behavior
