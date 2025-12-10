import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { env } from '../config/env';
import type { ImageFormats } from '../models/image_variants';

const S3_CONFIG = {
  region: env.AWS_REGION,
  bucket: env.S3_BUCKET_NAME,
};

const s3Client = new S3Client({
  region: S3_CONFIG.region,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

export class S3Service {
  /**
   * Get the original S3 key for an image
   */
  static getOriginalKey(imageId: string): string {
    return imageId;
  }

  /**
   * Get the variant S3 key for an image
   */
  static getVariantKey(imageId: string, width: number, height: number, format: ImageFormats) {
    // Split name and extension
    const dotIndex = imageId.lastIndexOf('.');
    if (dotIndex === -1) throw new Error('Invalid filename, missing extension');

    const name = imageId.slice(0, dotIndex);

    // Build new variant
    return `${name}___${width}x${height}.${format}`;
  }

  /**
   * Generate public S3 URL for a key
   */
  static getPublicUrl(s3Key: string): string {
    // URL encode the key to handle special characters
    const encodedKey = s3Key.split('/').map(encodeURIComponent).join('/');

    return `${env.S3_PUBLIC_URL}/${encodedKey}`;
  }

  /**
   * Download an image from S3 as a buffer (for worker processing)
   */
  static async downloadImageAsBuffer(s3Key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: S3_CONFIG.bucket,
        Key: s3Key,
      });

      const response = await s3Client.send(command);

      if (!response.Body) {
        throw new Error('Empty response body from S3');
      }

      // Convert stream to buffer
      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`Failed to download image from S3: ${s3Key}`, error);
      throw new Error(`S3 download failed: ${s3Key}`);
    }
  }

  /**
   * Download an image from S3 as a stream
   */
  static async downloadImage(s3Key: string): Promise<{
    stream: Readable;
    contentType: string;
    contentLength: number;
  }> {
    try {
      const command = new GetObjectCommand({
        Bucket: S3_CONFIG.bucket,
        Key: s3Key,
      });

      const response = await s3Client.send(command);

      if (!response.Body) {
        throw new Error('Empty response body from S3');
      }

      return {
        stream: response.Body as Readable,
        contentType: response.ContentType || 'application/octet-stream',
        contentLength: response.ContentLength || 0,
      };
    } catch (error) {
      console.error(`Failed to download image from S3: ${s3Key}`, error);
      throw new Error(`S3 download failed: ${s3Key}`);
    }
  }

  /**
   * Upload an image buffer to S3
   */
  static async uploadImage(s3Key: string, buffer: Buffer, contentType: string): Promise<void> {
    try {
      console.log('Uploading Buffer with content Type', contentType);
      const command = new PutObjectCommand({
        Bucket: S3_CONFIG.bucket,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType,
        // Optional: Add cache control headers
        CacheControl: 'public, max-age=31536000, immutable',
      });

      await s3Client.send(command);
      console.log(`Successfully uploaded image to S3: ${s3Key}`);
    } catch (error) {
      console.error(`Failed to upload image to S3: ${s3Key}`, error);
      throw new Error(`S3 upload failed: ${s3Key}`);
    }
  }

  static async deleteObject(s3Key: string): Promise<void> {
    try {
      console.log(`Deleting S3 object: ${s3Key}`);
      const command = new DeleteObjectCommand({
        Bucket: S3_CONFIG.bucket,
        Key: s3Key,
      });

      await s3Client.send(command);
      console.log(`Successfully deleted S3 object: ${s3Key}`);
    } catch (error) {
      console.error(`Failed to delete S3 object: ${s3Key}`, error);
      throw new Error(`S3 delete failed: ${s3Key}`);
    }
  }

  static async deleteObjects(s3Keys: string[]): Promise<void> {
    try {
      console.log(`Deleting S3 objects: ${s3Keys}`);
      const command = new DeleteObjectsCommand({
        Bucket: S3_CONFIG.bucket,
        Delete: {
          Objects: s3Keys.map((s3Key) => ({ Key: s3Key })),
        },
      });

      await s3Client.send(command);
      console.log(`Successfully deleted S3 objects: ${s3Keys}`);
    } catch (error) {
      console.error(`Failed to delete S3 objects: ${s3Keys}`, error);
      throw new Error(`S3 delete failed: ${s3Keys}`);
    }
  }

  /**
   * Check if an object exists in S3
   */
  static async exists(s3Key: string): Promise<boolean> {
    try {
      console.log(`Checking S3 object existence: ${s3Key}`);
      const command = new HeadObjectCommand({
        Bucket: S3_CONFIG.bucket,
        Key: s3Key,
      });

      await s3Client.send(command);
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      console.error(`Failed to check S3 object existence: ${s3Key}`, error);
      throw error;
    }
  }

  /**
   * Get the S3 bucket name
   */
  static getBucket(): string {
    return S3_CONFIG.bucket;
  }
}
