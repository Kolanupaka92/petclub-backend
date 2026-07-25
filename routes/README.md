# Routes — modular-monolith extraction

`server.js` grew to ~5,700 lines with 100+ handlers in one file. We're
decomposing it into per-domain route modules **incrementally** — no big-bang
rewrite, so risk stays low and the app keeps shipping.

## The pattern: dependency-injected router factory

`server.js` builds its singletons inline (`supabase`, `logger`, `auth`,
notification helpers, constants). Rather than extract all of those first, each
route module exports a **factory** that receives what it needs:

```js
// routes/geo.js
module.exports = function createGeoRouter({ supabase, logger, auth, supportEmail }) {
  const router = express.Router();
  router.get('/geocode', auth, async (req, res) => { /* ... */ });
  return router;
};
```

```js
// server.js
const createGeoRouter = require('./routes/geo');
app.use('/api', createGeoRouter({ supabase, logger, auth, supportEmail: SUPPORT_EMAIL }));
```

This keeps routes decoupled from module globals and makes them unit-testable in
isolation (inject fakes). Mount all routers under `/api`; each declares its own
sub-path (`/geocode`).

## Extraction order (largest / most-cohesive first)

| Domain | Handlers | Status |
|--------|---------:|--------|
| `geo` (geocode, reverse-geocode) | 2 | ✅ extracted |
| `auth` (send-otp, verify, refresh, logout) | ~9 | ☐ |
| `bookings` (create, status, respond, location) | ~16 | ☐ |
| `professionals` (earnings, payout, verification) | ~10 | ☐ |
| `pets` | ~6 | ☐ |
| `loyalty` | ~3 | ☐ |
| `admin` | ~23 | ☐ |
| `cron` | ~8 | ☐ |
| `payments` / `subscriptions` | ~11 | ☐ (defer until LLC/payments live) |

## Rules

1. **Behavior-preserving** — extraction is a move, not a rewrite. Same paths,
   same logic. Verify `npm test` stays green after each domain.
2. **One domain per PR** — small, reviewable, easy to revert.
3. **Shared helpers** that several domains need (e.g. `dbError`, `maskPhone`,
   notification senders) graduate into `lib/` or `services/` when the second
   consumer appears — not before.
