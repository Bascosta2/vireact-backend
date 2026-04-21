import 'dotenv/config'; // Load environment variables FIRST
import app from './app.js';
import { PORT, NODE_ENV, FRONTEND_URL, BACKEND_URL, DB_URL, JWT_SECRET, ACCESS_TOKEN_SECRET, SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, STRIPE_SECRET_KEY, TWELVE_LABS_API_KEY, TWELVELABS_USER_INDEX, TWELVELABS_DATASET_INDEX, OPENAI_API_KEY, RESEND_API_KEY, UPSTASH_REDIS_REST_URL, QSTASH_TOKEN, QSTASH_URL, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, AWS_ACCESS_KEY_ID } from './config/index.js';
import { connectDB, isConnected } from './db/index.js';

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

startServer();
