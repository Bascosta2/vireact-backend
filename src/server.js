import './config/load-env.js'; // Load environment variables FIRST (.env.local over .env in dev)
import { runStartupGuards } from './config/env-guards.js';
try {
  runStartupGuards();
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}
const { default: app } = await import('./app.js');
import { PORT, NODE_ENV, FRONTEND_URL, BACKEND_URL, DB_URL, JWT_SECRET, ACCESS_TOKEN_SECRET, SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, STRIPE_SECRET_KEY, STRIPE_PRICE_ID_PREMIUM, STRIPE_PRICE_ID_PRO, TWELVE_LABS_API_KEY, TWELVELABS_USER_INDEX, TWELVELABS_DATASET_INDEX, OPENAI_API_KEY, RESEND_API_KEY, UPSTASH_REDIS_REST_URL, QSTASH_TOKEN, QSTASH_URL, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, AWS_ACCESS_KEY_ID } from './config/index.js';
import { connectDB, isConnected } from './db/index.js';
import { markShuttingDown, runningJobIds, waitForRunningJobs } from './queue/analysis-runtime.js';
import { sweepStuckAnalyses, handOffRunningJobs } from './service/analysis-recovery.service.js';
import { sweepStuckEdits } from './service/editor/edit-job.service.js';
import { cleanStaleUploads } from './middleware/fileUpload.js';
import { initErrorTracking, sendDailySummary, captureError } from './service/ops-monitoring.service.js';

// Safety net for errors no request handler caught. A rejected promise is logged and recorded, and the
// server keeps running. An uncaught exception leaves the process in an unknown state: record it, then
// exit so Railway restarts a clean instance (the sweeper re-queues any analysis that was running).
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
  captureError(reason instanceof Error ? reason : new Error(String(reason)), { source: 'process', route: 'unhandledRejection' });
});
process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught exception:', error);
  captureError(error, { source: 'process', route: 'uncaughtException' });
  setTimeout(() => process.exit(1), 1500).unref?.();
});
import { maybeRunScheduledResearch } from './service/kb-research/runner.js';

/** UTC hour for the daily summary (default 13:00 UTC, 8 or 9 am US Eastern). */
const DAILY_SUMMARY_UTC_HOUR = Number(process.env.DAILY_SUMMARY_UTC_HOUR ?? 13);
let lastSummaryDay = null;
const maybeSendDailySummary = async () => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== DAILY_SUMMARY_UTC_HOUR || lastSummaryDay === day || !isConnected()) return;
  lastSummaryDay = day;
  await sendDailySummary();
};

/** How long a deploy waits for running analyses before handing them to the new instance. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 25000;
/** How often stuck analyses are looked for (default 5 minutes). */
const ANALYSIS_SWEEP_INTERVAL_MS = Number(process.env.ANALYSIS_SWEEP_INTERVAL_MS) || 5 * 60 * 1000;

let httpServer = null;
let sweepTimer = null;

const runSweep = async () => {
  await cleanStaleUploads();
  if (!isConnected()) return;
  try {
    await sweepStuckAnalyses();
  } catch (error) {
    console.error('[Recovery] Sweep failed:', error.message);
  }
  try {
    await sweepStuckEdits();
  } catch (error) {
    console.error('[Editor] Sweep failed:', error.message);
  }
};
import { isServerAnalyticsEnabled, shutdownAnalytics } from './lib/analytics.js';

const startServer = async () => {
  try {
    // Log startup information
    console.log('\n🚀 Starting Vireact Backend...');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV || 'not set'}`);
    console.log(`🔗 Frontend URL: ${FRONTEND_URL || '❌ Missing'}`);
    console.log(`🔗 Backend URL: ${BACKEND_URL || '❌ Missing'}`);
    console.log('───────────────────────────────────────────────────────────');
    
    // Log service configurations
    console.log('\n📦 SERVICE CONFIGURATION STATUS:');
    console.log(`   MongoDB: ${DB_URL ? '✅ Configured' : '❌ Missing DB_URL'}`);
    console.log(`   JWT Secret: ${JWT_SECRET ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Google OAuth: ${GOOGLE_CLIENT_ID ? '✅ Configured' : '❌ Missing'}`);
    console.log(`   Stripe: ${STRIPE_SECRET_KEY ? '✅ Configured' : '❌ Missing'}`);
    const twelveLabsIndexNote = TWELVELABS_USER_INDEX && TWELVELABS_DATASET_INDEX
        ? ''
        : ` — ⚠️ missing: ${[!TWELVELABS_USER_INDEX && 'TWELVELABS_USER_INDEX', !TWELVELABS_DATASET_INDEX && 'TWELVELABS_DATASET_INDEX'].filter(Boolean).join(', ')}`;
    console.log(`   Twelve Labs: ${TWELVE_LABS_API_KEY ? '✅ API key set' : '❌ Missing TWELVE_LABS_API_KEY'}${twelveLabsIndexNote}`);
    console.log(`   OpenAI: ${OPENAI_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log(`   Resend Email: ${RESEND_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log(`   Redis: ${UPSTASH_REDIS_REST_URL ? '✅ Configured' : '❌ Missing'}`);
    console.log(`   QStash: ${QSTASH_TOKEN ? '✅ Configured' : '❌ Missing'}`);
    console.log(`   AWS S3: ${AWS_ACCESS_KEY_ID ? '✅ Configured' : '⚠️ Not configured (optional)'}`);
    console.log(`   PostHog: ${isServerAnalyticsEnabled() ? '✅ Configured' : '⚠️ Not configured (server events disabled)'}`);
    console.log('───────────────────────────────────────────────────────────\n');

    if (NODE_ENV === 'production') {
      const requiredProdEnvs = [
        ['ACCESS_TOKEN_SECRET', ACCESS_TOKEN_SECRET],
        ['REFRESH_TOKEN_SECRET', process.env.REFRESH_TOKEN_SECRET],
        ['SESSION_SECRET', SESSION_SECRET],
        ['STRIPE_WEBHOOK_SECRET', process.env.STRIPE_WEBHOOK_SECRET],
        ['QSTASH_CURRENT_SIGNING_KEY', QSTASH_CURRENT_SIGNING_KEY],
        ['QSTASH_NEXT_SIGNING_KEY', QSTASH_NEXT_SIGNING_KEY],
      ].filter(([, value]) => !value);
      if (requiredProdEnvs.length > 0) {
        console.error(
          'FATAL: Required production env vars missing:',
          requiredProdEnvs.map(([name]) => name).join(', ')
        );
        process.exit(1);
      }
      const prodWarnings = [];
      if (!GOOGLE_CALLBACK_URL) prodWarnings.push('GOOGLE_CALLBACK_URL');
      if (!FRONTEND_URL) prodWarnings.push('FRONTEND_URL');
      if (!TWELVELABS_USER_INDEX) prodWarnings.push('TWELVELABS_USER_INDEX');
      if (!TWELVELABS_DATASET_INDEX) prodWarnings.push('TWELVELABS_DATASET_INDEX');
      if (!RESEND_API_KEY) prodWarnings.push('RESEND_API_KEY');
      if (!STRIPE_PRICE_ID_PREMIUM) prodWarnings.push('STRIPE_PRICE_ID_PREMIUM');
      if (!STRIPE_PRICE_ID_PRO) prodWarnings.push('STRIPE_PRICE_ID_PRO');
      if (!process.env.REFRESH_TOKEN_PEPPER) prodWarnings.push('REFRESH_TOKEN_PEPPER (refresh tokens stored as unpeppered SHA-256)');
      if (prodWarnings.length > 0) {
        console.warn(
          '⚠️  PRODUCTION WARNING: Recommended env vars missing (app may misbehave):',
          prodWarnings.join(', ')
        );
      }
    }

    console.log('📡 Connecting to MongoDB...');
    console.log(`   Connection String: ${DB_URL ? DB_URL.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') : 'NOT SET'}`);
    
    // Wait for MongoDB connection before starting server
    await initErrorTracking();
    await connectDB();
    
    // Verify connection
    if (isConnected()) {
      const mongoose = (await import('mongoose')).default;
      const dbName = mongoose.connection.db?.databaseName || 'unknown';
      console.log(`✅ MongoDB Connected successfully to database: ${dbName}`);
      console.log('   Host: [hidden]');
    } else {
      console.warn('⚠️ MongoDB connection status unclear, but continuing...');
    }
    
    // Start server after MongoDB connection
    const server = app.listen(PORT, '0.0.0.0', () => {
      httpServer = server;
      console.log('\n✅ Server started successfully!');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`📍 Port: ${PORT}`);
      console.log(`🌍 Environment: ${NODE_ENV || 'not set'}`);
      console.log(`🔗 Backend URL: http://localhost:${PORT}`);
      console.log(`🎯 Frontend URL: ${FRONTEND_URL || '❌ Missing'}`);
      console.log(`📦 MongoDB: ${isConnected() ? '✅ Connected' : '⏳ Connecting...'}`);
      console.log('═══════════════════════════════════════════════════════════');
      console.log('Available endpoints:');
      console.log(`  GET  http://localhost:${PORT}/health`);
      console.log(`  GET  http://localhost:${PORT}/api/health`);
      console.log(`  GET  http://localhost:${PORT}/api/db-status`);
      console.log(`  POST http://localhost:${PORT}/api/v1/auth/login`);
      console.log('═══════════════════════════════════════════════════════════\n');

      const webhookUrl = `${BACKEND_URL || ''}/api/v1/videos/analyze`;

      console.log('\n=== DEPLOYMENT CONFIG (startup) ===');
      console.log('NODE_ENV:', NODE_ENV || '(not set)');
      console.log('PORT:', PORT);
      console.log('FRONTEND_URL:', FRONTEND_URL || '(not set)');
      console.log('BACKEND_URL:', BACKEND_URL || '(not set)');
      console.log('QSTASH_URL:', QSTASH_URL || '(not set)');
      console.log('QStash token configured:', !!QSTASH_TOKEN);
      console.log('QSTASH_CURRENT_SIGNING_KEY exists:', !!QSTASH_CURRENT_SIGNING_KEY);
      console.log('QSTASH_NEXT_SIGNING_KEY exists:', !!QSTASH_NEXT_SIGNING_KEY);
      console.log('MongoDB configured:', !!DB_URL);
      console.log('QStash webhook URL:', webhookUrl);
      console.log('===================================\n');
    });
    
    // Recover analyses interrupted by a deploy or crash: first check a minute after boot, then every 5 minutes.
    setTimeout(runSweep, 60 * 1000).unref?.();
    sweepTimer = setInterval(runSweep, ANALYSIS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
    setInterval(() => void maybeSendDailySummary(), 10 * 60 * 1000).unref?.();
    // Weekly knowledge research (only when KB_RESEARCH_AUTO=true); results wait for review.
    setInterval(() => void maybeRunScheduledResearch(), 6 * 60 * 60 * 1000).unref?.();

    // Handle server errors (port conflicts, etc.)
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} is already in use!`);
        console.error('   Solution: Kill the process using this port or change PORT in .env');
        console.error(`   Windows: netstat -ano | findstr :${PORT}`);
        console.error(`   Mac/Linux: lsof -ti:${PORT} | xargs kill`);
      } else {
        console.error('❌ Server failed to start:', err.message);
        console.error('   Full error:', err);
      }
      process.exit(1);
    });
  } catch (err) {
    console.error('\n❌ Failed to start server:');
    console.error('   Error:', err.message);
    console.error('   Stack:', err.stack);
    process.exit(1);
  }
}

/**
 * Graceful shutdown (Railway sends SIGTERM on every deploy):
 * 1. stop taking analysis jobs (the webhook answers 503 so QStash retries on the new instance);
 * 2. hand running jobs back to the queue, delayed past the grace period, so nothing is lost if this
 *    process is killed (if it finishes first, its result wins and the delayed message is a no-op);
 * 3. stop accepting connections, give running jobs SHUTDOWN_GRACE_MS to finish, flush analytics, exit.
 */
const flushAndExit = async (signal) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  markShuttingDown();
  if (sweepTimer) clearInterval(sweepTimer);
  try {
    if (runningJobIds().length > 0 && isConnected()) {
      await handOffRunningJobs({ delaySeconds: Math.ceil(SHUTDOWN_GRACE_MS / 1000) + 20 });
    }
  } catch (error) {
    console.error('[Shutdown] Could not hand off running jobs:', error.message);
  }
  if (httpServer) httpServer.close();
  const stillRunning = await waitForRunningJobs(SHUTDOWN_GRACE_MS);
  if (stillRunning.length > 0) {
    console.warn(`[Shutdown] ${stillRunning.length} job(s) still running; they were handed to the queue and will resume on the new instance`);
  }
  await Promise.race([shutdownAnalytics(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(0);
};
process.once('SIGTERM', () => flushAndExit('SIGTERM'));
process.once('SIGINT', () => flushAndExit('SIGINT'));

startServer();
