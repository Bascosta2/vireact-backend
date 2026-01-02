import mongoose from 'mongoose';
import debug from 'debug';
import { DB_URL, IS_LAMBDA, NODE_ENV, DB_NAME } from '../config/index.js';
import { CONNECTION_TIMEOUT, MAX_RETRIES,RETRY_DELAY } from '../constants.js';
const dbDebug = debug('app:database');

// Connection options optimized for serverless environments
const connectionOptions = {
  family: 4, // Use IPv4, skip trying IPv6
  maxPoolSize: 10, // Reduced for serverless
  minPoolSize: 1, // Reduced for serverless
  // Serverless optimizations
  autoIndex: NODE_ENV === 'development', // Only enable in development
  // Serverless-specific options
  connectTimeoutMS: CONNECTION_TIMEOUT,
  retryWrites: true,
  retryReads: true,
  dbName: DB_NAME
};

// Global connection cache for serverless
let cachedConnection = null;

class DatabaseConnection {
  constructor() {
    this.retryCount = 0;
    this.isConnecting = false;
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    mongoose.connection.on('connected', () => {
      dbDebug('Mongoose connected to MongoDB');
    });

    mongoose.connection.on('error', (err) => {
      dbDebug(`Mongoose connection error: ${err}`);
    });

    mongoose.connection.on('disconnected', () => {
      dbDebug('Mongoose disconnected from MongoDB');
      // Clear cached connection on disconnect
      cachedConnection = null;
    });

    // Handle application termination gracefully (only in non-serverless environments)
    if (NODE_ENV !== 'production' || !IS_LAMBDA) {
      process.on('SIGINT', this.handleGracefulShutdown.bind(this));
      process.on('SIGTERM', this.handleGracefulShutdown.bind(this));
    }
  }

  async connectWithRetry() {
    // Return cached connection if available and connected
    if (cachedConnection && mongoose.connection.readyState === 1) {
      dbDebug('Using cached database connection');
      return cachedConnection;
    }

    if (this.isConnecting) {
      dbDebug('Connection already in progress, waiting...');
      // Wait for existing connection attempt
      while (this.isConnecting) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return cachedConnection;
    }

    this.isConnecting = true;
    const mongoURI = DB_URL;

    try {
      // Close existing connection if it exists
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
      }

      await mongoose.connect(mongoURI, connectionOptions);
      dbDebug('MongoDB connected successfully');
      this.retryCount = 0;
      this.isConnecting = false;

      // Cache the connection
      cachedConnection = mongoose.connection;
      return cachedConnection;
    } catch (err) {
      this.isConnecting = false;
      dbDebug(`MongoDB connection error: ${err}`);

      if (this.retryCount < MAX_RETRIES) {
        this.retryCount++;
        dbDebug(`Retrying connection... Attempt ${this.retryCount} of ${MAX_RETRIES}`);
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return this.connectWithRetry();
      } else {
        dbDebug('Max retries reached. Could not connect to MongoDB');
        // console.log(err)
        throw new Error('Failed to connect to MongoDB after maximum retries');

      }
    }
  }

  async handleGracefulShutdown() {
    dbDebug('Received shutdown signal, closing database connection...');

    try {
      await mongoose.connection.close();
      cachedConnection = null;
      dbDebug('MongoDB connection closed through app termination');
      process.exit(0);
    } catch (err) {
      dbDebug(`Error while closing MongoDB connection: ${err}`);
      process.exit(1);
    }
  }

  getConnection() {
    return mongoose.connection;
  }

  isConnected() {
    return mongoose.connection.readyState === 1;
  }

  // Serverless-specific method to close connection
  async closeConnection() {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      cachedConnection = null;
      dbDebug('Database connection closed for serverless cleanup');
    }
  }
}

// Create singleton instance
const databaseConnection = new DatabaseConnection();

// Export the connection and connection function
export const connectDB = () => databaseConnection.connectWithRetry();
export const connection = databaseConnection.getConnection();
export const isConnected = () => databaseConnection.isConnected();
export const closeConnection = () => databaseConnection.closeConnection();
export default databaseConnection;
