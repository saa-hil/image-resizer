import mongoose from 'mongoose';
import { env } from './env';

export const connectDB = async (): Promise<void> => {
  try {
    if (mongoose.connection.readyState === 1) {
      console.log('Mongo already connected');
      return;
    }

    await mongoose.connect(env.MONGODB_URI, {
      dbName: env.DB_NAME,
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    console.log('Mongo connected');
    
    mongoose.connection.on('error', (error) => {
      console.error('Mongo connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('Mongo disconnected');
    });

  } catch (error) {
    console.error('Mongo connection error:', error);
    throw error;
  }
};

export const closeDB = async (): Promise<void> => {
  try {
    await mongoose.connection.close();
    console.log('Mongo connection closed');
  } catch (error) {
    console.error('Error closing Mongo connection:', error);
  }
};