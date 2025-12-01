import mongoose from 'mongoose';
import { S3Service } from './s3.service';
import { ImageVariants, ImageStatus } from '../models/image_variants';
import { addImageVariantJob } from '../queues/image-variants.queue';

export class ImageService {
  /**
   * Get image variant or trigger creation if not exists
   * Returns the S3 key to stream from
   */
  static async getOrCreateVariant(
    imageId: string,
    width: number,
    height: number,
  ): Promise<{
    s3Key: string;
    shouldStreamOriginal: boolean;
  }> {
    try {
      // Check if variant exists in MongoDB
      const existingVariant = await ImageVariants.findOne({
        imageId,
        width,
        height,
      });

      // If variant exists and is ready, return it
      if (existingVariant && existingVariant.status === ImageStatus.Ready) {
        return {
          s3Key: existingVariant.s3Key,
          shouldStreamOriginal: false,
        };
      }

      // If variant is already queued or processing, serve original
      if (
        existingVariant &&
        (existingVariant.status === ImageStatus.Queued ||
          existingVariant.status === ImageStatus.Processing)
      ) {
        return {
          s3Key: existingVariant.originalS3Key,
          shouldStreamOriginal: true,
        };
      }

      // Variant doesn't exist or failed - create new one
      const originalS3Key = S3Service.getOriginalKey(imageId);
      const variantS3Key = S3Service.getVariantKey(imageId, width, height);
      const s3Bucket = S3Service.getBucket();

      console.log('Original S3 Key', originalS3Key);
      console.log('Variant S3 Key', variantS3Key);
      console.log('S3 Bucket', s3Bucket);

      // Verify original exists
      const originalExists = await S3Service.exists(originalS3Key);
      if (!originalExists) {
        throw new Error(`Original image not found: ${imageId}`);
      }

      // Create MongoDB record
      const variantDoc = await ImageVariants.create({
        imageId,
        width,
        height,
        s3Key: variantS3Key,
        s3Bucket,
        status: ImageStatus.Queued,
        originalS3Key,
        fileSize: 0,
      });

      // Add job to queue
      await addImageVariantJob({
        imageId,
        width,
        height,
        originalS3Key,
        variantS3Key,
        mongoDocId: variantDoc._id.toString(),
      });

      // Serve original while variant is being processed
      return {
        s3Key: originalS3Key,
        shouldStreamOriginal: true,
      };
    } catch (e) {
      console.error('Error getting or creating image variant:', e);
      throw e;
    }
  }

  /**
   * Get original image (when no dimensions provided)
   */
  static async getOriginal(imageId: string): Promise<string> {
    const originalS3Key = S3Service.getOriginalKey(imageId);

    // Verify original exists
    const exists = await S3Service.exists(originalS3Key);
    if (!exists) {
      throw new Error(`Original image not found: ${imageId}`);
    }

    return originalS3Key;
  }
}
