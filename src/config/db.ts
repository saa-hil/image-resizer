import mongoose from 'mongoose';
import { env } from './env';
import logger from '../utils/logger';

export const connectDB = async (): Promise<void> => {
  try {
    if (mongoose.connection.readyState === 1) {
      logger.info('Mongo already connected');
      return;
    }

    await mongoose.connect(env.MONGODB_URI, {
      dbName: env.DB_NAME,
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info('Mongo connected');

    mongoose.connection.on('error', (error) => {
      logger.error('Mongo connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      logger.info('Mongo disconnected');
    });
  } catch (error) {
    logger.error('Mongo connection error:', error);
    throw error;
  }
};

export const closeDB = async (): Promise<void> => {
  try {
    await mongoose.connection.close();
    logger.info('Mongo connection closed');
  } catch (error) {
    logger.error('Error closing Mongo connection:', error);
  }
};
