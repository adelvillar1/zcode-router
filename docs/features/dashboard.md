# Feature: Dashboard

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Admin Tool.

## Purpose

The kit's only UI: a local ops panel served by the router at `http://127.0.0.1:8300/dashboard` — usage visibility and roster editing without leaving the browser. Single file (`router/dashboard.html`), vanilla JS, no build step, no dependencies.

## What it shows

- **Usage** — the ledger by model and by day (calls, errors, tokens), plus a live view over the recent-request ring via SSE.
- **Delegation editor** — edit roster fields (tiers, delegation, profiles) and **Save & apply**: `PUT /api/roster` writes the roster and re-applies through the kit's own path, so the dashboard can never produce state the kit wouldn't.
- **Suggestions** — `GET /api/suggest` ranks models by measured latency and errors, declared context, quota headroom, and optional roster `strength` (1–5); hard-tier and aggregator suggestions sharpen with strength. Models without a declared strength rank neutral and the panel says so.
- **Workflows / delegation registry** — the library view with install state and assignability; the doctor cross-checks it (skipped hand-launched workflows stay visible).

## Auth

Local-token: API calls beyond `/healthz` require `Bearer <localToken>`; the served page is stamped with the current token (`INJECTED_TOKEN`) so the browser needs no configuration.

## Theme

Light/dark toggle in the header (the sun/moon button). Default follows the OS via `prefers-color-scheme`; an explicit choice is persisted per browser in `localStorage` (`zcode-router-theme`) and wins over the OS on reload. A pre-paint script in `<head>` sets `data-theme` before first render, so there is no flash of the wrong theme. Both palettes are CSS-variable blocks on `:root` (dark = GitHub dark, light = GitHub light); native form controls follow via `color-scheme`.

## Endpoints behind the tabs

`GET /api/state` · `GET /api/usage` · `POST /api/usage/reset` · `GET /api/suggest` · `GET|PUT /api/roster`.

## Where the code lives

`router/dashboard.html`; data endpoints in `router/server.js`; suggestion ranking in `router/suggest.mjs`.
