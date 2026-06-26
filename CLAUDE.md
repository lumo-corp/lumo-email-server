# CLAUDE.md — lumo-email-server

## Project Overview

A lightweight Node.js HTTP proxy server that handles appointment booking confirmations for [lumo-ai.de](https://lumo-ai.de). On each booking it:

1. Creates a Google Calendar event (with a Google Meet link) via OAuth2
2. Injects the Meet link into HTML email templates
3. Sends confirmation emails to both the customer and the site owner via the [Resend](https://resend.com) API

The entire server is a single file: `server.js`.

---

## Tech Stack

| Concern | Solution |
|---|---|
| Runtime | Node.js ≥ 18 (uses native `fetch`) |
| Email sending | [Resend API](https://resend.com) (REST, not SMTP) |
| Calendar + Meet links | Google Calendar API v3 via `googleapis` npm package |
| Auth | Google OAuth2 with a stored refresh token (no Service Account / Workspace needed) |
| HTTP server | Node.js built-in `http` module (no Express/Fastify) |

> **Note:** `nodemailer` is listed in `package.json` but is **not used** in `server.js`. Email delivery goes entirely through the Resend REST API. It is a legacy dependency and can be removed.

---

## Environment Variables

All secrets are injected at runtime via environment variables. No `.env` file is committed.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | No | `3001` | HTTP listen port |
| `RESEND_API_KEY` | Yes | — | Resend API key for sending emails |
| `GOOGLE_OAUTH_CLIENT_ID` | Yes* | — | Google OAuth2 client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Yes* | — | Google OAuth2 client secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Yes* | — | Long-lived OAuth2 refresh token |
| `GOOGLE_CALENDAR_ID` | No | `"primary"` | Target calendar (email address or `"primary"`) |

\* Google credentials are optional at startup — the server runs without them, but calendar creation and Meet links will be skipped.

### Why OAuth2 instead of a Service Account

A bare JWT Service Account cannot generate Google Meet links without Google Workspace + Domain-Wide Delegation. OAuth2 acting as a real user account generates Meet links normally and writes directly to that user's personal calendar.

The OAuth2 redirect URI registered in Google Cloud Console must be `https://lumo-ai.de/`.

---

## Running the Server

```bash
npm install
node server.js
# or
npm start
```

The server logs startup warnings for any missing environment variables.

---

## API Reference

### `POST /send-email`

The only functional endpoint.

**Request body (JSON):**

```json
{
  "toCustomer": {
    "to": "customer@example.com",
    "subject": "LUMO – Erstgespräch, Mo. 30. Jun. 2026, 10:00",
    "html": "<html>...{{MEET_LINK}}...</html>"
  },
  "toOwner": {
    "to": "hallo@lumo-ai.de",
    "subject": "Neue Buchung: ...",
    "html": "<html>...{{MEET_LINK}}...</html>"
  },
  "startZeit": "2026-06-30T10:00:00+02:00",
  "endZeit": "2026-06-30T11:00:00+02:00"
}
```

- `toCustomer.to` and `toOwner.to` are both required; missing either returns HTTP 400.
- `startZeit` / `endZeit` are ISO 8601 datetime strings. If omitted, the calendar step is skipped.
- All datetimes are treated as `Europe/Berlin` timezone.

**Response (JSON):**

```json
{ "ok": true, "emailSent": true, "meetLink": "https://meet.google.com/xyz-abc-def" }
```

- `emailSent` is `false` if the Resend call failed (calendar entry may still have been created).
- `meetLink` is `null` if calendar creation was skipped or failed.

The server always responds HTTP 200 even when partial failures occur; check `emailSent` and `meetLink` in the response body.

### `OPTIONS /send-email`

CORS preflight — returns HTTP 204 with appropriate headers.

### All other routes

Returns HTTP 404.

---

## CORS Policy

Allowed origins (hard-coded in `server.js`):

```
https://lumo-ai.de
https://www.lumo-ai.de
http://localhost
http://127.0.0.1
```

Requests from other origins receive no `Access-Control-Allow-Origin` header and will be blocked by browsers. Allowed methods: `POST`, `OPTIONS`. Allowed headers: `Content-Type`.

---

## Email HTML Template Convention

The HTML passed in `toCustomer.html` / `toOwner.html` must use these markers for Meet link injection:

```html
<!--MEET_LINK_START-->
  <a href="{{MEET_LINK}}">Google Meet beitreten</a>
<!--MEET_LINK_END-->
```

- If a Meet link was obtained: `{{MEET_LINK}}` is replaced with the URL.
- If no Meet link is available: the entire block between `<!--MEET_LINK_START-->` and `<!--MEET_LINK_END-->` (inclusive) is removed from the output.

---

## Execution Flow (per request)

```
POST /send-email
  │
  ├─ 1. Parse JSON body, validate toCustomer.to + toOwner.to
  │
  ├─ 2. Create Google Calendar event (conferenceDataVersion: 1)
  │       └─ Extract Meet link from conferenceData.entryPoints[type=video].uri
  │
  ├─ 3. injectMeetLink() on both customer and owner HTML
  │
  └─ 4. Promise.all → sendEmail(customer) + sendEmail(owner) via Resend
```

Steps 2–4 run sequentially (calendar first, then email) so that the Meet link is available before emails are sent.

---

## Key Conventions

- **Language:** Code comments and log messages are in German. Variable names are a mix of German (`toCustomer`, `startZeit`) and English.
- **No framework:** Plain `http.createServer` — do not introduce Express, Fastify, or similar unless explicitly requested.
- **No test suite:** There are no automated tests. Manual testing via `curl` or Postman is the current approach.
- **Single-file architecture:** All logic lives in `server.js`. Keep it that way unless complexity genuinely warrants splitting.
- **Error handling:** Failures in calendar creation or email sending are caught individually and logged, but the request still returns HTTP 200 with `ok: true`. The caller must check `emailSent` and `meetLink` flags.
- **No `.env` file:** Secrets must be set in the deployment environment, not committed to the repo.

---

## Development Workflow

1. Set required environment variables in your shell or deployment config.
2. `npm install` then `node server.js`.
3. Test with `curl`:

```bash
curl -X POST http://localhost:3001/send-email \
  -H "Content-Type: application/json" \
  -d '{
    "toCustomer": { "to": "test@example.com", "subject": "Test", "html": "<p>Hi</p>" },
    "toOwner":    { "to": "owner@lumo-ai.de", "subject": "Test", "html": "<p>Hi</p>" },
    "startZeit": "2026-07-01T10:00:00+02:00",
    "endZeit":   "2026-07-01T11:00:00+02:00"
  }'
```

4. Commit and push to the feature branch; there is no CI pipeline.

---

## Deployment Notes

- The server is designed to run on any Node.js ≥ 18 host (VPS, container, PaaS).
- From address is hard-coded: `LUMO Terminbuchung <hallo@lumo-ai.de>` — change this in `server.js` if the sender identity changes.
- The Google OAuth2 refresh token does not expire unless manually revoked or the app is deauthorized. If calendar events stop being created, check whether the token has been invalidated.
