import { Worker, Job, type ConnectionOptions } from 'bullmq';
import mongoose from 'mongoose';
import { redisConnection } from '../config/cache';
import { imageVariantQueue, type ImageVariantJobData } from '../queues/image-variants.queue';
import { S3Service } from '../services/s3.service';
import { ImageVariants, ImageStatus } from '../models/image_variants';
import sharp, { type FormatEnum } from 'sharp';
import { getContentType } from '../utils/helpers';
import { connectDB } from '../config/db';
import logger from '../utils/logger';
import { createRedisMonitor, startRedisHealthMonitoring } from '../utils/monitor';

interface JobTimings {
  jobStart: number;
  mongoCheck?: number;
  mongoUpdate1?: number;
  s3Download?: number;
  sharpProcessing?: number;
  s3Upload?: number;
  mongoUpdate2?: number;
  total?: number;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

// Ensure MongoDB is connected before creating worker
async function ensureMongoConnection(): Promise<void> {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const currentState = mongoose.connection.readyState;

  logger.info(`MongoDB connection state: ${states[currentState]} (${currentState})`);

  if (currentState === 0) {
    logger.warn('MongoDB disconnected, attempting to reconnect...');
    await withTimeout(connectDB(), 10000, 'MongoDB connection');
    logger.info('MongoDB reconnected successfully');
  } else if (currentState === 3) {
    logger.error('MongoDB is disconnecting, waiting and reconnecting...');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await withTimeout(connectDB(), 10000, 'MongoDB connection');
  } else if (currentState === 2) {
    logger.warn('MongoDB is connecting, waiting...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function processImageVariant(job: Job<ImageVariantJobData>): Promise<{
  success: boolean;
  variantS3Key: string;
  fileSize: number;
}> {
  const timings: JobTimings = {
    jobStart: Date.now(),
  };

  // Ensure connection at the start of each job
  await ensureMongoConnection();

  const { imageId, width, height, originalS3Key, variantS3Key, mongoDocId, imageFormat } = job.data;

  logger.info(`[${job.id}] Starting job for ${imageId} (${width}x${height}.${imageFormat})`, {
    jobId: job.id,
    imageId,
    dimensions: `${width}x${height}`,
    format: imageFormat,
    originalKey: originalS3Key,
    variantKey: variantS3Key,
    mongoDocId,
  });

  // Update job progress
  await job.updateProgress(5);

  try {
    // Step 1: Check if document exists
    logger.info(`[${job.id}] Checking MongoDB document existence...`);
    const checkStart = Date.now();

    const docExists = await withTimeout(
      ImageVariants.findById(mongoDocId).lean().exec(),
      15000,
      'MongoDB findById',
    );

    timings.mongoCheck = Date.now() - checkStart;
    logger.info(`[${job.id}] MongoDB check completed in ${timings.mongoCheck}ms`, {
      exists: !!docExists,
    });

    if (!docExists) {
      logger.error(`[${job.id}] MongoDB document not found: ${mongoDocId}`);
      throw new Error(`MongoDB document not found: ${mongoDocId}`);
    }

    await job.updateProgress(10);

    // Step 2: Update status to processing
    logger.info(`[${job.id}] Updating status to Processing...`);
    const updateStart = Date.now();

    const processingUpdate = await withTimeout(
      ImageVariants.findByIdAndUpdate(
        mongoDocId,
        { status: ImageStatus.Processing, processingStartedAt: new Date() },
        { new: true },
      ).exec(),
      15000,
      'MongoDB update to Processing',
    );

    timings.mongoUpdate1 = Date.now() - updateStart;
    logger.info(`[${job.id}] Status updated to Processing in ${timings.mongoUpdate1}ms`);

    if (!processingUpdate) {
      throw new Error(`Failed to update document to Processing status: ${mongoDocId}`);
    }

    await job.updateProgress(20);

    // Step 3: Download original image from S3
    logger.info(`[${job.id}] Downloading original image from S3: ${originalS3Key}`);
    const downloadStart = Date.now();

    const originalBuffer = await withTimeout(
      S3Service.downloadImageAsBuffer(originalS3Key),
      120000, // 2 minutes for large files
      'S3 download',
    );

    timings.s3Download = Date.now() - downloadStart;
    logger.info(`[${job.id}] S3 download completed in ${timings.s3Download}ms`, {
      sizeBytes: originalBuffer.length,
      sizeMB: (originalBuffer.length / (1024 * 1024)).toFixed(2),
    });

    await job.updateProgress(50);

    // Step 4: Resize image using Sharp
    logger.info(`[${job.id}] Processing image with Sharp...`);
    const sharpStart = Date.now();

    const resizedBuffer = await withTimeout(
      sharp(originalBuffer)
        .resize(width, height, {
          fit: 'cover',
          position: 'center',
        })
        .toFormat(imageFormat)
        .toBuffer(),
      60000, // 1 minute for processing
      'Sharp image processing',
    );

    timings.sharpProcessing = Date.now() - sharpStart;
    logger.info(`[${job.id}] Sharp processing completed in ${timings.sharpProcessing}ms`, {
      originalSizeMB: (originalBuffer.length / (1024 * 1024)).toFixed(2),
      resizedSizeMB: (resizedBuffer.length / (1024 * 1024)).toFixed(2),
      compressionRatio: ((1 - resizedBuffer.length / originalBuffer.length) * 100).toFixed(1),
    });

    await job.updateProgress(75);

    // Step 5: Upload variant to S3
    logger.info(`[${job.id}] Uploading variant to S3: ${variantS3Key}`);
    const uploadStart = Date.now();

    const contentType = await getContentType(resizedBuffer);
    await withTimeout(
      S3Service.uploadImage(variantS3Key, resizedBuffer, contentType),
      120000, // 2 minutes for upload
      'S3 upload',
    );

    timings.s3Upload = Date.now() - uploadStart;
    logger.info(`[${job.id}] S3 upload completed in ${timings.s3Upload}ms`, {
      contentType,
    });

    await job.updateProgress(90);

    // Step 6: Update MongoDB with success
    logger.info(`[${job.id}] Updating MongoDB with success status...`);
    const finalUpdateStart = Date.now();

    const successUpdate = await withTimeout(
      ImageVariants.findByIdAndUpdate(
        mongoDocId,
        {
          status: ImageStatus.Ready,
          fileSize: resizedBuffer.length,
          processingCompletedAt: new Date(),
        },
        { new: true },
      ).exec(),
      15000,
      'MongoDB update to Ready',
    );

    timings.mongoUpdate2 = Date.now() - finalUpdateStart;
    logger.info(`[${job.id}] MongoDB updated to Ready in ${timings.mongoUpdate2}ms`);

    if (!successUpdate) {
      throw new Error(`Failed to update MongoDB document to Ready: ${mongoDocId}`);
    }

    await job.updateProgress(100);

    // Calculate total time
    timings.total = Date.now() - timings.jobStart;

    logger.info(`[${job.id}] Job completed successfully in ${timings.total}ms`, {
      timings: {
        mongoCheck: `${timings.mongoCheck}ms`,
        mongoUpdate1: `${timings.mongoUpdate1}ms`,
        s3Download: `${timings.s3Download}ms`,
        sharpProcessing: `${timings.sharpProcessing}ms`,
        s3Upload: `${timings.s3Upload}ms`,
        mongoUpdate2: `${timings.mongoUpdate2}ms`,
        total: `${timings.total}ms`,
      },
      breakdown: {
        mongoPercent: (
          (((timings.mongoCheck || 0) + (timings.mongoUpdate1 || 0) + (timings.mongoUpdate2 || 0)) /
            timings.total) *
          100
        ).toFixed(1),
        s3Percent: (
          (((timings.s3Download || 0) + (timings.s3Upload || 0)) / timings.total) *
          100
        ).toFixed(1),
        sharpPercent: (((timings.sharpProcessing || 0) / timings.total) * 100).toFixed(1),
      },
    });

    return {
      success: true,
      variantS3Key,
      fileSize: resizedBuffer.length,
    };
  } catch (error) {
    const failedAt = Date.now() - timings.jobStart;

    logger.error(`[${job.id}] Job failed after ${failedAt}ms`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timings: {
        mongoCheck: timings.mongoCheck ? `${timings.mongoCheck}ms` : 'not completed',
        mongoUpdate1: timings.mongoUpdate1 ? `${timings.mongoUpdate1}ms` : 'not completed',
        s3Download: timings.s3Download ? `${timings.s3Download}ms` : 'not completed',
        sharpProcessing: timings.sharpProcessing ? `${timings.sharpProcessing}ms` : 'not completed',
        s3Upload: timings.s3Upload ? `${timings.s3Upload}ms` : 'not completed',
        mongoUpdate2: timings.mongoUpdate2 ? `${timings.mongoUpdate2}ms` : 'not completed',
        failedAt: `${failedAt}ms`,
      },
    });

    // Try to update MongoDB with failure status
    try {
      await withTimeout(
        ImageVariants.findByIdAndUpdate(
          mongoDocId,
          {
            status: ImageStatus.Failed,
            failedReason: error instanceof Error ? error.message : String(error),
            failedAt: new Date(),
          },
          { new: true },
        ).exec(),
        10000,
        'MongoDB update to Failed',
      );
      logger.info(`[${job.id}] MongoDB updated with failure status`);
    } catch (updateError) {
      logger.error(`[${job.id}] Failed to update MongoDB with failure status`, {
        updateError: updateError instanceof Error ? updateError.message : String(updateError),
      });
    }

    throw error; // Re-throw to trigger retry logic
  }
}

export const imageVariantWorker = new Worker<ImageVariantJobData>(
  'image-variant-processing',
  processImageVariant,
  {
    connection: redisConnection as ConnectionOptions,
    concurrency: 2,
    lockDuration: 300000,
    stalledInterval: 60000,
    maxStalledCount: 2,
  },
);

// Event listeners for monitoring
imageVariantWorker.on('completed', (job) => {
  logger.info(`[${job.id}] Job completed successfully`, {
    jobId: job.id,
    imageId: job.data.imageId,
    dimensions: `${job.data.width}x${job.data.height}`,
    returnValue: job.returnvalue,
  });
});

imageVariantWorker.on('failed', async (job, err) => {
  if (!job) {
    logger.error('Failed event received but job is undefined', { error: err.message });
    return;
  }

  logger.error(`[${job.id}] ❌ Job failed`, {
    jobId: job.id,
    imageId: job.data.imageId,
    error: err.message,
    stack: err.stack,
    attemptsMade: job.attemptsMade,
    attemptsLimit: job.opts.attempts,
  });

  // Update MongoDB with failure information
  try {
    await ImageVariants.findByIdAndUpdate(
      job.data.mongoDocId,
      {
        status: ImageStatus.Failed,
        failedReason: err.message,
        failedAt: new Date(),
      },
      { new: true },
    ).exec();
  } catch (updateError) {
    logger.error(`[${job.id}] Failed to update MongoDB after job failure`, {
      updateError: updateError instanceof Error ? updateError.message : String(updateError),
    });
  }

  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalFail = job.attemptsMade >= maxAttempts;

  if (!isFinalFail) {
    logger.info(`[${job.id}] Job will be retried (attempt ${job.attemptsMade}/${maxAttempts})`);
    return;
  }

  // Check if we should requeue
  const variant = await ImageVariants.findById(job.data.mongoDocId).lean().exec();
  if (variant && (variant.requeueCount ?? 0) >= 2) {
    logger.warn(`[${job.id}] Max requeue limit reached (2), not requeuing`, {
      requeueCount: variant.requeueCount,
    });
    return;
  }

  logger.info(`[${job.id}] Requeuing job after final failure...`, {
    requeueCount: (variant?.requeueCount ?? 0) + 1,
  });

  // Requeue the job
  await imageVariantQueue.add('process-image-variant', job.data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    jobId: `${job.data.imageId}_${job.data.width}x${job.data.height}_${job.data.mongoDocId}_${Date.now()}`,
    removeOnComplete: true,
    removeOnFail: false,
  });

  // Update MongoDB with requeue status
  await ImageVariants.findByIdAndUpdate(
    job.data.mongoDocId,
    {
      status: ImageStatus.Queued,
      $inc: { requeueCount: 1 },
      failedReason: null,
      failedAt: null,
    },
    { new: true },
  ).exec();

  logger.info(`[${job.id}] Job requeued successfully`, {
    imageId: job.data.imageId,
    dimensions: `${job.data.width}x${job.data.height}`,
  });
});

imageVariantWorker.on('error', (err) => {
  logger.error('Worker error occurred', {
    error: err.message,
    stack: err.stack,
    type: err.name,
  });
});

imageVariantWorker.on('stalled', async (jobId) => {
  logger.warn(`⚠️  Job ${jobId} has stalled`, {
    jobId,
    timestamp: new Date().toISOString(),
    note: 'Job will be moved back to wait state and retried',
  });

  // Try to get job details for debugging
  try {
    const job = await imageVariantQueue.getJob(jobId);
    if (job) {
      logger.warn(`[${jobId}] Stalled job details`, {
        jobId,
        imageId: job.data.imageId,
        dimensions: `${job.data.width}x${job.data.height}`,
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        progress: job.progress,
      });
    }
  } catch (error) {
    logger.error(`[${jobId}] Could not fetch stalled job details`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

imageVariantWorker.on('active', (job) => {
  logger.info(`[${job.id}] Job is now active`, {
    jobId: job.id,
    imageId: job.data.imageId,
    dimensions: `${job.data.width}x${job.data.height}`,
    attemptsMade: job.attemptsMade,
  });
});

imageVariantWorker.on('drained', () => {
  logger.info('Worker drained');
});

imageVariantWorker.on('progress', (job, progress) => {
  logger.debug(`[${job.id}] Progress: ${progress}%`, {
    jobId: job.id,
    progress,
  });
});

/**
 *
 * Redis Monitoring for connection health
 */
const redisMonitor = createRedisMonitor();
const redisHealthInterval = startRedisHealthMonitoring(redisMonitor);

// Monitor event loop lag (potential blocking operations)
let lastCheck = Date.now();
const eventLoopMonitor = setInterval(() => {
  const now = Date.now();
  const lag = now - lastCheck - 5000; // Expected 5 second interval

  if (lag > 1000) {
    logger.warn('Event loop lag detected', {
      lagMs: lag,
      note: 'Possible blocking operation detected',
    });
  }

  lastCheck = now;
}, 5000);

// Handle graceful shutdown
async function gracefulShutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully...`);

  clearInterval(eventLoopMonitor);
  clearInterval(redisHealthInterval);

  try {
    // Stop accepting new jobs
    await imageVariantWorker.close();
    logger.info('Worker closed successfully');

    // Close Redis monitor
    await redisMonitor.quit();
    logger.info('Redis monitor closed');

    // Close MongoDB connection
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Graceful shutdown function
export async function closeWorker(): Promise<void> {
  clearInterval(eventLoopMonitor);
  clearInterval(redisHealthInterval);
  await imageVariantWorker.close();
  await mongoose.connection.close();
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise),
  });
});

// Initialize connection when worker starts
ensureMongoConnection()
  .then(() => {
    logger.info('Image variant worker initialized successfully', {
      concurrency: 3,
      lockDuration: '180s',
      stalledInterval: '30s',
      maxStalledCount: 2,
    });
  })
  .catch((err) => {
    logger.error('Failed to establish MongoDB connection', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });
