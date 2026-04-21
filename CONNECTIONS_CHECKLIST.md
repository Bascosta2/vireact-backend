# Vireact – Internal & External Connections Checklist

Use this checklist when deploying or verifying backend and frontend after updates.

**Production reference (current):**

- Frontend: `https://vireact.io` (Vercel)
- Backend API: `https://vireact-backend-production-2775.up.railway.app` (Railway)

---

## Internal connections (Frontend ↔ Backend)

| Check | Description | Config |
|-------|-------------|--------|
| **API base URL** | Frontend calls backend at `/api/v1` (dev: proxy) or full URL (prod) | Frontend: `VITE_BACKEND_URL` in `.env`; `src/constants.ts`; `src/api/index.ts` |
| **Dev proxy** | In dev, Vite proxies `/api` → `http://localhost:5000` | `vireact-frontend/vite.config.ts` → `server.proxy['/api']` |
| **Dev health** | Startup check hits `/api/health` via `fetch` (same proxy) | `vireact-frontend/src/App.tsx` |
| **CORS** | Backend allows frontend origin | `vireact-backend/src/config/cors-allowed-origins.js` (`getAllowedCorsOrigins`) — used by `app.js` and `errorHandler.js` so error responses cannot widen origins in production |
| **Credentials** | Cookies/auth sent with requests | Frontend: `withCredentials: true` (axios); Backend: `credentials: true` (CORS) |
| **Rate limits** | Auth + upload + chat POST (not global) | `app.js`: auth + `/api/v1/videos/upload*`; `chat.route.js`: `chatPostRateLimit` on POST `/api/v1/chat/:videoId`; QStash `/api/v1/videos/analyze` and Stripe webhook are **not** limited |
| **Billing banner** | Payment failure notice | `UserPage` loads `/subscription`; if `subscription.paymentFailed`, shows dismissible banner (sessionStorage) linking to `/profile` and `/subscription-plans` |

### Required env (production)

- **Frontend** (Vercel build):
  - `VITE_BACKEND_URL` = public backend base URL, **no trailing slash** (e.g. `https://vireact-backend-production-2775.up.railway.app`)
  - `VITE_FRONTEND_URL` = `https://vireact.io` (or your canonical frontend origin)
  - `VITE_GOOGLE_CLIENT_ID` = Google OAuth Web client ID (same project as backend)
  - `VITE_STRIPE_PUBLISHABLE_KEY` — **not used** by the current app (Stripe hosted Checkout only); add only if you integrate Stripe.js / Elements

- **Backend** (Railway runtime):
  - `FRONTEND_URL` = `https://vireact.io` — used for CORS, Stripe success/cancel URLs, redirects
  - `BACKEND_URL` = public Railway API origin, **no trailing slash** — **required** for QStash (`publishVideoAnalysisJob` builds `{BACKEND_URL}/api/v1/videos/analyze`)

### API routes (backend)

- `/api/v1/auth` – auth (login, signup, Google OAuth)
- `/api/v1/videos` – video upload (file/URL), status, feedback, delete, mark-viewed
- `/api/v1/videos/:videoId/status` – **GET** video status (upload + analysis) for progress; when `analysisStatus` is `failed`, includes sanitized **`errorSummary`** (no raw provider errors)
- `/api/v1/videos/analyze` – **POST** QStash webhook (raw body + signature); not for browser calls
- `/api/v1/chat` – chat
- `/api/v1/profile` – profile
- `/api/v1/subscription` – subscription; Stripe webhook is **`POST /api/v1/subscription/webhook`** (registered in `app.js` before `express.json()`)
- `/api/v1/early-access` – early access
- `/api/health` – health check (MongoDB, Twelve Labs indexes, OpenAI, JWT)
- `/health` – simple health
- `/api/v1/admin/*` – admin ingest (header `x-admin-key`); includes `creator-videos/upload` for creator file ingest

---

## External connections (Backend → third‑party)

| Service | Purpose | Env vars | Config / notes |
|---------|--------|----------|----------------|
| **MongoDB** | DB | `DB_URL` | `src/db/index.js`; required. `Video` has compound index `{ uploader_id: 1, createdAt: -1 }` for user library queries |
| **Twelve Labs** | Video indexing & analysis | `TWELVE_LABS_API_KEY`, `TWELVELABS_USER_INDEX`, `TWELVELABS_DATASET_INDEX` | User uploads: `video.service.js`; admin dataset: `admin-ingest.service.js`. `TWELVE_LABS_INDEX_ID` is deprecated |
| **yt-dlp + ffmpeg** | Server-side fetch for TikTok / YouTube / Instagram URLs before Twelve Labs direct upload | Optional: `YT_DLP_PATH` (default `yt-dlp` on PATH), `YT_DLP_TIMEOUT_MS`, `SOCIAL_VIDEO_MAX_BYTES` | `social-video-fetch.service.js`, `social-video-url.js`. **Railway:** backend builds from `Dockerfile` (includes both tools). **Local:** install yt-dlp and ffmpeg or URL paste for those hosts will fail |
| **OpenAI** | Chat, scene parsing, feature analysis | `OPENAI_API_KEY` | `src/config/index.js`; analyzer + openai-response services |
| **QStash (Upstash)** | Async video analysis jobs | `QSTASH_TOKEN`, `QSTASH_URL` (if non-default), `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | `src/queue/video.queue.js` publishes to `{BACKEND_URL}/api/v1/videos/analyze`; `src/middleware/qstash-verify.js`. If publish fails after upload, video is marked `failed` and API returns **502** with message to use Re-analyze |
| **Stripe** | Subscriptions (live mode) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_STARTER`, `STRIPE_PRICE_ID_PRO`; `STRIPE_PUBLISHABLE_KEY` optional | Webhook before `express.json()` in `app.js`. **Production** requires `STRIPE_WEBHOOK_SECRET` (unsigned parsing disabled). `checkout.session.completed` creates a MongoDB subscription document if missing for `metadata.userId`. `invoice.payment_failed` sets `paymentFailed` + `paymentFailedAt` (UI banner; Stripe handles dunning). Cleared on successful invoice payment, checkout completion, user cancel, or subscription deleted. Other webhook events unchanged |
| **Resend** | Email | `RESEND_API_KEY` | Optional |
| **Google OAuth** | Login | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | `GOOGLE_CALLBACK_URL` must be `{BACKEND_URL}/api/v1/auth/google/callback` (exact match in Google Cloud Console) |
| **AWS S3** | (If used) file storage | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME`, `AWS_S3_REGION` | Optional |
| **Upstash Redis** | (If used) cache/session | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional; reported in `/api/health` |
| **JWT / Auth** | Session / API auth | `ACCESS_TOKEN_SECRET` (access JWT, short TTL), `REFRESH_TOKEN_SECRET` (refresh JWT — **required in production**, distinct from access), `SESSION_SECRET` (OAuth session cookie), `JWT_SECRET` optional for legacy checks | Production startup fails if access/refresh/session or webhook/QStash secrets are missing |
| **Admin ingest** | Local `admin-panel.html` | `ADMIN_API_KEY` on server; panel must set `BACKEND_URL` in script to target local or Railway API | `POST /api/v1/admin/ingest/paired-video` (My Videos), `POST /api/v1/admin/creator-videos/upload` (Creator Videos, multipart `videoFile`), `POST /api/v1/admin/ingest/knowledge`. Dataset ingest uses `TWELVELABS_DATASET_INDEX` only. See `SLASH_DOC.md` |

---

## Deployment

### Backend (Railway — primary production)

- **Build:** `Dockerfile` in `vireact-backend` (Node 20 + ffmpeg + yt-dlp via venv). `railway.json` uses `builder: DOCKERFILE`.
- **Process:** `node src/server.js` (container CMD)
- **Startup:** In `NODE_ENV=production`, logs a **WARNING** (non-fatal) if any of these are missing: `STRIPE_WEBHOOK_SECRET`, `GOOGLE_CALLBACK_URL`, `FRONTEND_URL`, `TWELVELABS_USER_INDEX`, `TWELVELABS_DATASET_INDEX`, `RESEND_API_KEY`
- **Env:** Set all backend variables in Railway (including `BACKEND_URL`, `FRONTEND_URL`, QStash signing keys, Stripe live keys and webhook secret, both Twelve Labs index IDs)
- **Stripe webhook URL:** `https://<your-railway-host>/api/v1/subscription/webhook` — use the **live** signing secret in `STRIPE_WEBHOOK_SECRET`

### Backend (Vercel — optional / alternate)

- **Entry:** `src/server.js` (see `vercel.json` → `builds`)
- Same env contract as Railway; ensure `BACKEND_URL` matches the URL Vercel exposes
- **Social URL ingest (yt-dlp):** not supported in typical Vercel serverless images unless you supply a custom runtime with yt-dlp + ffmpeg. Prefer **Railway + Dockerfile** for full URL paste behavior.

### Frontend (Vercel)

- **Build:** `npm run build` (tsc + vite build); output: `dist/`
- **Env:** `VITE_BACKEND_URL`, `VITE_FRONTEND_URL`, `VITE_GOOGLE_CLIENT_ID` for production
- **Sample:** `vireact-frontend/env.production.sample`
- **Vercel:** Framework preset = Vite; rewrites in `vercel.json` send `/(.*)` → `/` for SPA

### After deploy

1. **Health:** `GET https://<backend-url>/api/health` — check `services.mongo`, `twelveLabs`, `twelveLabsIndexId` (true when both Twelve Labs indexes set), `openai`, `jwt`.
2. **CORS:** Open `https://vireact.io`; confirm API calls succeed without CORS errors.
3. **Video flow:** Upload a small video; confirm QStash delivery if configured; poll `GET /api/v1/videos/:videoId/status`.
4. **Stripe:** Confirm live webhook deliveries in Stripe Dashboard; test checkout with live prices.

---

## Videos Library (frontend)

- **VideoCard** (`src/components/UI/VideoCard/index.tsx`): Animated card with hover preview, status badges, progress bar for pending analysis, Chat / Re-analyze / Delete.
- **Videos page** (`src/pages/User/Videos/index.tsx`): Search, sort (date/name/status), filter (feature/status), auto-refresh every 5s when any video is pending analysis. Uses existing `getUserVideos` and `deleteVideo` from `@/api/video`. Re-analyze navigates to `/upload` with `state.reanalyzeVideoId`. Chat and card click go to `/videos/:videoId` when analysis is complete.

---

## Quick verification (local)

```bash
# Backend
cd vireact-backend && npm run dev

# Frontend (separate terminal)
cd vireact-frontend && npm run dev
```

- Frontend: http://localhost:5174  
- Backend: http://localhost:5000  
- API health: http://localhost:5000/api/health  
- In dev, frontend uses proxy; `VITE_BACKEND_URL` optional (defaults for dev in `constants.ts`).

---

## Timeouts

- **Video upload (frontend):** 5 minutes (`VIDEO_UPLOAD_TIMEOUT_MS` in `src/api/video.ts`) to avoid 30s default timeout during Twelve Labs upload/indexing.
- **Axios default (other calls):** 30s in `src/api/index.ts`; video upload overrides per request.
