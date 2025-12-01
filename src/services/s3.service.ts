import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { env } from '../config/env';

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
    return `images/${imageId}`;
  }

  /**
   * Get the variant S3 key for an image
   */
  static getVariantKey(imageId: string, width: number, height: number) {
    // Split name and extension
    const dotIndex = imageId.lastIndexOf('.');
    if (dotIndex === -1) throw new Error('Invalid filename, missing extension');

    const name = imageId.slice(0, dotIndex);
    const ext = imageId.split('.');
    const extension = ext[ext.length - 1];

    // Build new variant
    return `resized_images/${name}___${width}*${height}.${extension}`;
  }

  /**
   * Generate public S3 URL for a key
   */
  static getPublicUrl(s3Key: string): string {
    const region = S3_CONFIG.region;
    const bucket = S3_CONFIG.bucket;

    // Standard S3 public URL format
    // URL encode the key to handle special characters
    const encodedKey = s3Key.split('/').map(encodeURIComponent).join('/');

    return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
  }

  /**
   * Extract file extension from imageId
   */
  private static getExtension(imageId: string): string {
    const parts = imageId.split('.');
    return parts.length > 1 ? (parts[parts.length - 1] as string) : 'jpg';
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

  /**
   * Check if an object exists in S3
   */
  static async exists(s3Key: string): Promise<boolean> {
    try {
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
