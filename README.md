# ulink-is-ai

Simple Express API scaffold with cookie parsing, request logging, and environment configuration.

## Setup
1. Install dependencies: `npm install`
2. Copy env template: `cp .env.example .env` and adjust values if needed.
3. Start the server: `npm start` (entrypoint `src/bin/www`)
4. Dev with auto-reload (WSL-friendly): `npm run dev` (uses `nodemon --legacy-watch` against `src/bin/www`)

The API exposes a basic health check at `GET /health`. Debug logging can be enabled with `DEBUG=app:*`.
