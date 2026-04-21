# Vireact.io — Slash Doc (Agent Source of Truth)

> **This file is a persistent guardrail for Cursor and any AI agent working in this codebase and it should be implemented in the repository.**
> Before making significant changes, re-read this file. Do not silently change user-facing behavior
> without updating the relevant section below.

---

## 1. Product Vision

Vireact.io is an AI-native SaaS web app built for short-form video creators, editors, and creator teams. Its primary job is to analyze short-form videos (TikTok, Instagram Reels, YouTube Shorts, Facebook Reels) and predict a realistic view-range band *before* the video is posted — then deliver highly specific, timestamp-level feedback on exactly what to fix and why.

The product provides analytic, frame-aware feedback on hooks, pacing, retention curves, and structural quality — surfaced through a live AI chatbot and a structured analysis report. A first-class in-house editing workflow (driven by AI-suggested fixes) is part of the long-term product vision and should be architecturally anticipated in every meaningful decision.

Vireact must always feel like a polished, modern B2B/B2C SaaS dashboard — not a toy demo, not a research prototype. Every screen, state, and interaction should communicate trust, speed, and professional utility.

---

## 2. Core User Flows (MVP)

### 2.1 Upload / Import Flow
- User lands on the **Upload** page and either:
  - Drags and drops a video file (MP4, MOV, WEBM, AVI, MKV — max 200MB, 5s–60s duration), or
  - Pastes a URL from YouTube Shorts, TikTok, Instagram Reels, or Facebook.
- For **allowlisted** Shorts / TikTok / Instagram page URLs, the **backend downloads the video with yt-dlp** (plus ffmpeg for merge) and uploads it to Twelve Labs as a direct file ingest. Other URLs are still passed to Twelve Labs `method: url` when the host is not in that allowlist. Production Railway deploy uses the backend **Dockerfile** so yt-dlp and ffmpeg are present; local dev needs them on PATH or set `YT_DLP_PATH`. Private, geo-blocked, or DRM-heavy links may fail with a clear API error.
- User continues to the **Features** page (`/features`), selects which analysis features to run (Hook, Pacing, Audio, Captions, Views Predictor, Advanced Analytics), and starts analysis (single upload + job to backend).
- **Home** (`/dashboard`) is a workflow overview; feature picking is not on Home or on Upload.
- App triggers backend job and transitions to an "analysis in progress" state.
- UI is non-blocking: user should never see a frozen screen. Show job status for upload and analysis (e.g. pending / queued / processing through complete).

### 2.2 Analysis & Predictive Analytics
After analysis completes, the system returns:
- **Predicted View Band**: An estimated range (e.g. "75K–110K views") with a confidence tier (conservative / expected / optimistic). Communicate these as *approximations*, not guarantees.
- **Score Metrics**:
  - Overall Virality Score (0–100)
  - Hook Score
  - Pacing & Rhythm Score
  - Audio Score
  - Caption Clarity Score
  - Hook Swipe Rate % (lower = better)
- **Retention Curve**: Estimated audience retention over video duration.
- **Risk Flags**: Specific signals that hurt performance — slow hook, dead time, repeated shots, visual drop-off, weak audio.

### 2.3 Feedback & Chatbot
- A live AI chatbot panel surfaces alongside the analysis report.
- The chatbot must:
  - Explain *why* the model scored the video the way it did.
  - Give concrete, timestamp-specific improvement suggestions (e.g. "Cut 0.5s from 0:01–0:02," "Move this hook to the opening frame," "Tighten the pause at 0:08").
  - Answer follow-up questions in the context of the current video's analysis data.
  - Reference the video's actual metrics — not generic advice.
- The chatbot panel lives to the LEFT of the analysis report in the detail view (split-screen layout).
- Chat history persists for the session. User should not lose their conversation on page refresh.

### 2.4 Editing / Iteration
- **Initial scope**: An edit suggestion list (actionable fix items from the AI, each with a timestamp and description).
- **Long-term vision**: Full in-house AI editor — trim, reorder, captions, overlays, audio adjustments — directly connected to the AI suggestion engine. User applies a suggestion, re-analyzes, and iterates.
- Every architectural decision in the editing surface should anticipate this tight AI ↔ editor feedback loop.

---

## 3. Non-Goals (Guardrails)

The following are explicitly out of scope. Agents must not drift Vireact toward these:

- ❌ A generic video editor (not Premiere, not CapCut, not DaVinci).
- ❌ A social media scheduler, CRM, or publishing tool.
- ❌ A long-form content analytics platform. Short-form (≤60s) is the primary focus.
- ❌ An SEO/keyword/tag optimization tool (TubeBuddy / vidIQ space) — beyond minimal metadata support.
- ❌ A platform for podcast, blog, or static image content.
- ❌ A bulk export / repurposing tool (Opus Clip / Klap space).

If a proposed feature or code change pulls toward any of the above, stop and reconsider alignment with the product vision.

---

## 4. UX & Design Principles

- **Desktop-first, mobile-friendly.** The core analysis and editing experience is designed for desktop. Mobile must be usable but is not the primary surface.
- **Pre-login home (mobile)**: Directly under the hero primary CTA, a `md:hidden` row shows scaled previews of the three differentiation widgets (retention slider with autoplay animation, virality range + scenarios, DNA helix + content DNA bars). The feature cards still hide those full widgets on small screens (`hidden md:flex`); desktop hero uses the link input + upload row instead. Below the hero, the three differentiation cards (Actionable Edits, Virality Prediction, Personalized Coaching) use a single-view carousel with ~70% width slides, side peeks, 4s auto-advance, swipe, and dots—desktop keeps the three-column grid.
- **Layout pattern**: Sidebar navigation (collapsible) → main content panel → optional right-side or left-side chat/insights panel. Do not break this spatial logic.
- **Visual language**:
  - Dark background base (`#0a0a0f` or similar near-black).
  - Accent palette: brand pink (`#FF3CAC`) and brand orange (`#FF8C00`) for interactive elements, CTAs, and score highlights. Use sparingly — these are accents, not fill colors.
  - Glassmorphism cards: `rgba(255,255,255,0.04)` background, `1px solid rgba(255,255,255,0.08)` border, `border-radius: 12px`.
  - Muted secondary text: `#71717a` (zinc-500). White for primary content.
- **Always make the next action obvious**: Upload, re-analyze, apply suggestion, or ask the chatbot. Every screen must have a clear primary CTA.
- **Expose metrics in creator language**: view bands ("75K–110K"), retention percentages, hook grades (A/B/C or 0–100), pacing scores. Never expose raw model internals to users.
- **Avoid visual noise**: limited color, strong typography hierarchy, generous whitespace. When in doubt, remove rather than add.
- **Loading, error, and empty states are first-class UI** — not afterthoughts. Every async operation needs all three handled visually.

---

## 5. Technical Principles & Constraints

### Frontend
- **Stack**: React + TypeScript. Use strict typing. No `any` without a comment explaining why.
- **Component architecture**:
  - `layout/` — page shells, sidebar, nav.
  - `components/ui/` — shared primitives (Button, Badge, Card, Input, Tooltip, etc.).
  - `components/domain/` — feature-specific components: `UploadPanel`, `AnalysisReport`, `ChatPanel`, `VideoCard`, `ScoreRing`, `RetentionChart`, `AccordionFeedback`, etc.
  - `hooks/` — custom hooks for data fetching, polling, chat state, etc.
- **Composition over monoliths**: Keep components focused and under ~200 lines. Extract when a component does more than one thing.
- **Styling**: Tailwind CSS utility classes. Avoid inline style objects unless required for dynamic values (e.g. conic-gradient degree, animation width). Do not introduce a second styling system.
- **Animation**: Prefer CSS transitions and Tailwind for simple states. Use `framer-motion` for complex mount/exit animations if already installed. Do not add heavy animation libraries for trivial effects.

### Backend Integration
- **Production (e.g. Railway):** QStash calls `POST /api/v1/videos/analyze` on the public `BACKEND_URL` with signature verification (signing keys required). There is no unauthenticated debug route; re-queue analysis via authenticated `POST /api/v1/videos/:videoId/reanalyze`.
- **Rate limits:** `express-rate-limit` applies to `/api/v1/auth`, video upload paths under `/api/v1/videos/upload*`, and **POST** `/api/v1/chat/:videoId` (OpenAI cost protection). Webhooks (`/api/v1/videos/analyze`, `/api/v1/subscription/webhook`) are **not** rate limited.
- **Upload → QStash:** If `publishVideoAnalysisJob` fails after Twelve Labs indexing, the video is marked analysis **failed**, the API returns an error (502) with guidance to use **Re-analyze**, and polling `GET /videos/:videoId/status` returns a sanitized `errorSummary` when status is `failed`.
- **Stripe billing:** Subscription documents may include `paymentFailed` and `paymentFailedAt` after `invoice.payment_failed` (for in-app banner; access follows Stripe until dunning/cancel). `checkout.session.completed` creates the subscription row if it is missing for the metadata `userId`.
- **Production startup:** Process exits if required secrets are missing (`ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `SESSION_SECRET`, `STRIPE_WEBHOOK_SECRET`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`). A non-fatal WARNING is logged if recommended vars are missing (`GOOGLE_CALLBACK_URL`, `FRONTEND_URL`, both Twelve Labs user/dataset index IDs, `RESEND_API_KEY`).
- The frontend treats all video analysis and prediction as **async jobs**. Never assume synchronous results.
- **Analysis job** (`analysisStatus` from the API): `pending` → `queued` (Twelve Labs indexing done, job published to QStash, waiting for webhook claim) → `processing` (worker running analyzers) → `completed` | `failed`. **Upload** uses separate `uploadStatus`: `pending` → `uploading` → `completed` | `failed`.
- Always implement: loading state, error state, empty state for every API-dependent component.
- API response shapes should match the domain entities in Section 5 below. Do not reshape data silently in components.

### Local admin ingest (`admin-panel.html`)
- **Purpose only**: operators use the standalone HTML file (opened locally, not via Vite) to ingest **My Videos** (paired file + metrics), **Creator Videos** (creator file upload + metrics), and **Knowledge** into the backend. It is not part of the React app shell.
- **Requirements**: `vireact-backend` running and reachable; `ADMIN_API_KEY` in `vireact-backend/.env` must match the `ADMIN_API_KEY` constant at the top of `admin-panel.html` (local tooling only — do not deploy or commit that file with a real key). Admin video ingest uses **Twelve Labs** with `TWELVELABS_DATASET_INDEX` only (training/dataset index). End-user uploads use `TWELVELABS_USER_INDEX` — unchanged.
- **Creator Videos tab**: `POST /api/v1/admin/creator-videos/upload` (multipart: `videoFile`, platform, actualViews, creatorHandle, subscriberCount, creatorSize, viralCategory, optional analytics fields). No niche field. Max file size 500MB; MP4 / MOV / WEBM. After Twelve Labs analyze + analyzers, the pipeline stores `VideoPerformanceDataset` (no niche) and one **KnowledgeBase** document with `metadata.source: 'admin_creator_ingest'`, `metadata.topic: 'general'`, and embedding of a **psychological/structural** summary (hook mechanics, pacing, audio, captions, emotion, performance vs creator size) — not topic niche. RAG retrieval in the six analyzers uses **vector similarity** on embeddings with a topic filter that includes **`general`** alongside the feature topic so these profiles surface cross-niche.
- **Auth probe**: the panel calls `GET /api/v1/admin/ping` with header `x-admin-key` (same as ingest routes). A 200 means backend is up and admin auth matches; 401 means key mismatch or missing `ADMIN_API_KEY` on the server.

### Domain Entities (keep stable — update this doc if shape changes)
```ts
interface Video {
  id: string
  userId: string
  filename: string
  url?: string
  /** When ingest used server-side social download */
  sourceUrl?: string
  sourceTitle?: string
  sourceDescription?: string
  platform?: 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'upload'
  fileSizeBytes: number
  durationSeconds: number
  analyzedAt: string
  uploadStatus: 'pending' | 'uploading' | 'completed' | 'failed'
  // CHANGED: 2026-04 — align with API; analysis uses `analysisStatus` including QStash handoff `queued`
  analysisStatus: 'pending' | 'queued' | 'processing' | 'completed' | 'failed'
  features: AnalysisFeature[]
  analysis?: VideoAnalysis
}

type AnalysisFeature = 'hook' | 'pacing' | 'audio' | 'caption' | 'views_predictor' | 'advanced_analytics'

interface VideoAnalysis {
  viralityScore: number          // 0–100
  hookScore: number              // 0–100
  pacingScore: number            // 0–100
  audioScore: number             // 0–100
  captionClarityScore: number    // 0–100
  hookSwipeRate: number          // 0–100, lower is better
  predictedViewsLow: number
  predictedViewsHigh: number
  predictedViewsExpected: number
  retentionCurve: number[]       // array of % values over video duration
  feedbackItems: FeedbackItem[]
}

interface FeedbackItem {
  feature: AnalysisFeature
  whatIsWrong: string
  suggestionsToImprove: string[]
  timestampStart?: number        // seconds
  timestampEnd?: number          // seconds
  severity: 'low' | 'medium' | 'high'
}

interface PredictionBand {
  label: 'conservative' | 'expected' | 'optimistic'
  probability: number            // e.g. 0.15, 0.89, 0.35
  viewsLow: number
  viewsHigh: number
}
```

**Backend implementation (as of 2026):** The Video document stores `analysis[]` with `score` (0–100), `rating`, `feedback`, `suggestions` per feature; top-level `viralityScore`, `predictedViewsLow`, `predictedViewsHigh`, `predictedViewsExpected`, `retentionCurve`. GET `/videos/:id` returns the video with a normalized `analysis` object (VideoAnalysis DTO): legacy flat fields (`hookScore`, etc.), `feedbackItems` from `timestampFeedback` (severity ∈ critical|important|minor), plus `scores` (nullable per feature), `predictedViews` { low, expected, high }, and `features` { hook, pacing, audio, caption, viewsPredictor, advanced } each `{ score, rating, feedback, suggestions }` or null.

### Performance
- Never block the UI while analysis runs. Use polling or WebSocket/SSE for job status.
- Use progressive disclosure: show partial results as they arrive where possible.
- Lazy-load heavy components (charts, editor) that are not needed on first paint.

---

## 6. AI / Analytics Behavior Expectations

- **Predictions are approximate bands, not guarantees.** The UI must always communicate uncertainty. Use language like "estimated range," "based on similar content," "confidence: 89%."
- **Feedback must be**:
  - **Specific**: Always point to timestamps, frames, or structural moments. Never give generic advice like "improve your hook" without a concrete "how."
  - **Actionable**: Tell the user exactly what to cut, move, trim, or replace.
  - **Non-patronizing**: Users are creators who take their content seriously. Treat them as professionals, not beginners.
- **The chatbot must**:
  - Reference the actual video's metrics and feedback items in every response. Pass the full `VideoAnalysis` object as system context on every API call.
  - Maintain context within the session (include full message history in each API call).
  - Never fabricate platform-specific policies (TikTok algorithm rules, YouTube Shorts ranking factors). If uncertain, say "I'm not certain — check the platform's official creator resources."
  - Never respond with generic advice that could apply to any video. Every answer should be grounded in this specific video's data.

---

## 7. Future Directions (Agents: keep architecture open for these)

- **Multi-video comparison dashboards**: Side-by-side analysis for B2B teams managing multiple creators or campaigns.
- **Team workspaces**: Role-based access — creators, editors, managers. Shared video libraries and analysis history.
- **A/B testing workflows**: Upload multiple cuts of the same hook or intro; predict which performs better and explain why.
- **In-house AI editor**: A timeline-based editor tightly coupled to the feedback engine. User sees a suggestion → clicks "Apply" → the edit is made in-app → re-analysis runs automatically.
- **Trend awareness**: Surface trending audio, hooks, and formats in a user's niche to inform creation before upload.
- **API / integrations**: Vireact API for agencies to plug into their own workflows; export reports as PDF or JSON.

---

## 8. Coding Style & Agent Instructions

### General
- Prefer small, well-named components and functions. If you can't name it clearly, it's probably doing too much.
- Match new UI strictly to the existing design system: same button variants, same card style, same typography scale, same spacing tokens.
- No orphaned `console.log` statements in committed code.
- No commented-out dead code blocks left in files after a change.

### When modifying domain entities
- Check this slash doc first (Section 5 domain entities).
- If the shape must change, update the interface here and leave a `// CHANGED: [reason] [date]` comment on the modified field.
- Broadcast the change in the PR description so other agents and humans can adjust consumers.

### Before significant refactors
1. Re-read this entire slash doc.
2. Confirm the refactor preserves all flows in Section 2.
3. Do not silently change any user-facing behavior.
4. Update this doc if the refactor changes architecture, data shapes, or UX patterns.

### Placeholder data
- Any hardcoded mock value must be commented: `// PLACEHOLDER — replace with real API data`
- Never ship placeholder data to production without a corresponding TODO ticket reference.

### Accessibility
- All interactive elements must be keyboard-navigable and have appropriate `aria-label` or `aria-describedby` attributes.
- Color is never the sole indicator of state (always pair with text or icon).

---

*Last updated: April 2026 — update this date whenever a major section changes.*
