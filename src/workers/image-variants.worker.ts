import { Worker, Job } from 'bullmq';
import mongoose from 'mongoose';
import { redisConnection } from '../config/cache';
import { imageVariantQueue, type ImageVariantJobData } from '../queues/image-variants.queue';
import { S3Service } from '../services/s3.service';
import { ImageVariants, ImageStatus } from '../models/image_variants';
import sharp from 'sharp';
import { getContentType } from '../utils/helpers';
import { connectDB } from '../config/db';

// Ensure MongoDB is connected before creating worker
async function ensureMongoConnection() {
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }
}

export const imageVariantWorker = new Worker<ImageVariantJobData>(
  'image-variant-processing',
  async (job: Job<ImageVariantJobData>) => {
    // Ensure connection at the start of each job
    await ensureMongoConnection();

    const { imageId, width, height, originalS3Key, variantS3Key, mongoDocId } = job.data;

    console.log(`Processing job ${job.id}: ${imageId} ${width}x${height}`);
    console.log(`Job Id: ${mongoDocId}`);

    try {
      // Update status to processing
      const processingUpdate = await ImageVariants.findByIdAndUpdate(
        mongoDocId,
        { status: ImageStatus.Processing },
        { new: true },
      );

      if (!processingUpdate) {
        throw new Error(`MongoDB document not found: ${mongoDocId}`);
      }

      console.log(`Updated status to Processing for doc: ${mongoDocId}`);

      // Step 1: Download original image from S3
      console.log(`Downloading original: ${originalS3Key}`);
      const originalBuffer = await S3Service.downloadImageAsBuffer(originalS3Key);

      // Step 2: Resize image using Sharp
      console.log(`Resizing to ${width}x${height}`);
      const resizedBuffer = await sharp(originalBuffer)
        .resize(width, height, {
          fit: 'cover',
          position: 'center',
        })
        .toBuffer();

      // Step 3: Upload variant to S3
      console.log(`Uploading variant: ${variantS3Key}`);
      const contentType = await getContentType(resizedBuffer);
      await S3Service.uploadImage(variantS3Key, resizedBuffer, contentType);

      // Step 4: Update MongoDB with success
      const successUpdate = await ImageVariants.findByIdAndUpdate(
        mongoDocId,
        {
          status: ImageStatus.Ready,
          fileSize: resizedBuffer.length,
        },
        { new: true },
      );

      if (!successUpdate) {
        throw new Error(`Failed to update MongoDB document: ${mongoDocId}`);
      }

      console.log(`Successfully processed: ${imageId} ${width}x${height}`);

      return {
        success: true,
        variantS3Key,
        fileSize: resizedBuffer.length,
      };
    } catch (error) {
      console.error(`Failed to process job ${job.id}:`, error);
      // Step 5: Update MongoDB with failure
      try {
        await ImageVariants.findByIdAndUpdate(
          mongoDocId,
          { status: ImageStatus.Failed },
          { new: true },
        );
      } catch (updateError) {
        console.error(`Failed to update failure status for ${mongoDocId}:`, updateError);
      }
      throw error; // This will trigger retry logic
    }
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
);

// Event listeners for monitoring
imageVariantWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

imageVariantWorker.on('failed', async (job, err) => {
  if (!job) return;

  console.error(`Job ${job.id} failed:`, err.message);

  await ImageVariants.findByIdAndUpdate(
    job.data.mongoDocId,
    {
      status: ImageStatus.Failed,
      failedReason: err.message,
      failedAt: new Date(),
    },
    { new: true },
  );

  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalFail = job.attemptsMade >= maxAttempts;

  if (!isFinalFail) return;

  const variant = await ImageVariants.findById(job.data.mongoDocId);
  if (variant && (variant.requeueCount ?? 0) >= 2) {
    console.log(`Skipping requeue for ${job.id} — already retried twice`);
    return;
  }

  console.log(`Job ${job.id} reached max attempts (${maxAttempts}), requeuing...`);

  await imageVariantQueue.add('process-image-variant', job.data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    jobId: `${job.data.imageId}_${job.data.width}x${job.data.height}_${job.data.mongoDocId}_${Date.now()}`,
    removeOnComplete: true,
    removeOnFail: false,
  });

  await ImageVariants.findByIdAndUpdate(job.data.mongoDocId, {
    status: ImageStatus.Queued,
    $inc: { requeueCount: 1 },
    failedReason: null,
    failedAt: null,
  });

  console.log(`Requeued job for image ${job.data.imageId} (${job.data.width}x${job.data.height})`);
});

imageVariantWorker.on('error', (err) => {
  console.error('Worker error:', err);
});

imageVariantWorker.on('stalled', (jobId) => {
  console.log(`Job ${jobId} stalled`);
});

imageVariantWorker.on('active', (job) => {
  console.log(`Job ${job.id} is now active`);
});

// Handle graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully...`);
  await imageVariantWorker.close();
  await mongoose.connection.close();
  console.log('Worker and MongoDB connection closed');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Graceful shutdown function
export async function closeWorker(): Promise<void> {
  await imageVariantWorker.close();
  await mongoose.connection.close();
}

// Initialize connection when worker starts
ensureMongoConnection().catch((err) => {
  console.error('Failed to establish MongoDB connection:', err);
  process.exit(1);
});
