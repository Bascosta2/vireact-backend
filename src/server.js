import app from './app.js';
import { PORT, NODE_ENV } from './config/index.js';
import { connectDB } from './db/index.js';

const startServer = async () => {
  try {
    await connectDB(); // Connect once in non-serverless environments

    app.listen(PORT, () => {
      console.log(`🚀 Vireact server running on port ${PORT}`);
      console.log(`📝 Environment: ${NODE_ENV}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}


startServer();
