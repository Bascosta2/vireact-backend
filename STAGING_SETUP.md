# Staging setup

Goal: every change is tried on a staging copy of Vireact before real users see it, and nothing on a
developer's machine can touch production data. These steps need account owner access; the code already
supports all of it through environment variables.

## 1. Databases (MongoDB Atlas)

1. Create a second Atlas cluster (or project) named `vireact-staging`. The free M0 tier is enough to start.
2. Create two databases on it: `vireact_staging` (the staging site) and `vireact_dev` (local development).
3. Create the Atlas Vector Search index on `knowledgebases.embedding` with the same definition as
   production (name it the same as `KNOWLEDGE_BASE_VECTOR_INDEX`).
4. Copy the knowledge base: run `node src/scripts/mongodb/migrate-kb.js` with the environment variables `SOURCE_MONGO_URI` = production
   and `DEST_MONGO_URI` = staging. This reads production and writes staging only.

## 2. Twelve Labs

Create a staging index (Marengo 3.0, options `visual` and `audio`) and note its id.

## 3. Railway

1. In the Railway project, add an environment named `staging` (Project settings, Environments).
2. Copy production variables, then change:
   - `DB_URL` -> the staging cluster URI, `DB_NAME=vireact_staging`
   - `TWELVELABS_USER_INDEX` -> the staging index id
   - `BACKEND_URL` / `FRONTEND_URL` -> the staging URLs
   - `STRIPE_*` -> Stripe test-mode keys
   - `SENTRY_ENVIRONMENT=staging`
3. Point the staging environment at a `staging` git branch, so pushes to `main` stay production-only.
4. In production, set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` so a deploy lets running analyses finish
   (the backend waits up to `SHUTDOWN_GRACE_MS`, 25 s, then hands unfinished jobs to the new server).

## 4. Vercel

Set `VITE_BACKEND_URL` for the Preview environment to the staging Railway URL. Every pull request then
gets a preview site that talks to staging.

## 5. Local development

Point `.env.local` at the staging cluster's `vireact_dev` database. The startup guard
(`src/config/env-guards.js`) refuses to run against a database named like production unless
`ALLOW_PROD_DB_IN_DEV=true` is set deliberately.

## 6. Release flow

1. Merge to `staging`, let Railway and Vercel deploy it.
2. Upload a short test clip on the staging site; check the report, chat and Scripts tab.
3. Merge `staging` into `main`.
