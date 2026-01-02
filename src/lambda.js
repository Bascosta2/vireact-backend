import serverless from 'serverless-http';
import app from './app.js';
import { connectDB } from './db/index.js';

let isConnected = false;

const handler = async (event, context) => {
  if (!isConnected) {
    await connectDB(); // connect once per cold start
    isConnected = true;
  }

  const expressHandler = serverless(app);
  return expressHandler(event, context);
};

export const handlerLambda = handler; // named export for AWS
export default handler; // default for frameworks like Vercel
