import { Queue } from 'bullmq';
import { redisConnection } from '../config/cache';
import type { ImageFormats } from '../models/image_variants';

export interface ImageVariantJobData {
  imageId: string;
  width: number;
  height: number;
  originalS3Key: string;
  variantS3Key: string;
  mongoDocId: string; // To update the document after processing
  imageFormat: ImageFormats;
}

// Create the queue
export const imageVariantQueue = new Queue<ImageVariantJobData>('image-variant-processing', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Retry failed jobs up to 3 times
    backoff: {
      type: 'exponential',
      delay: 2000, // Start with 2 second delay, doubles each retry
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000, // Keep last 1000 completed jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

// Helper function to add job to queue
export async function addImageVariantJob(data: ImageVariantJobData): Promise<void> {
  try {
    await imageVariantQueue.add('process-image-variant', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      jobId: `${data.imageId}_${data.width}x${data.height}.${data.imageFormat}.${data.mongoDocId}.${Date.now()}`, // Prevents duplicate jobs
      removeOnComplete: true,
      removeOnFail: false,
    });
    console.log(`Added job to queue: ${data.imageId} ${data.width}x${data.height}`);
  } catch (error) {
    console.error('Failed to add job to queue:', error);
    throw error;
  }
}

// Graceful shutdown
export async function closeQueue(): Promise<void> {
  await imageVariantQueue.close();
}
