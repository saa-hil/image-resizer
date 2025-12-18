import { type Context } from 'elysia';
import { ImageService } from '../services/image.service';
import { S3Service } from '../services/s3.service';
import { ImageQuerySchema } from '../utils/helpers';
import type { ImageFormats } from '../models/image_variants';
import logger from '../utils/logger';
import { env } from '../config/env';

export class ImageController {
  /**
   * Handle image request
   * GET /:imageId?w=800&h=600
   */
  static async getImage(ctx: Context) {
    try {
      const queryResults = ImageQuerySchema.safeParse(ctx.query);
      const path = ctx.path;
      // const ip = (ctx as unknown as { ip: string }).ip;
      const ip = ctx.headers['x-real-ip'] || 'unknwon';
      if (!queryResults.success) {
        ctx.set.status = 400;
        return {
          error: 'Invalid query parameters or request',
          message: queryResults.error ? JSON.parse(queryResults.error.message) : 'Invalid request',
        };
      }

      const { w, h } = ctx.query as { w?: string; h?: string };
      const { format } = ctx.query as { format?: ImageFormats };
      const { force_resize } = ctx.query as { force_resize?: string };

      // Remove First Slash from path
      const pathWithoutSlash = path.startsWith('/') ? path.slice(1) : path;

      let resizedPathPrefix = env.RESIZED_IMAGE_PATH.startsWith('/')
        ? env.RESIZED_IMAGE_PATH.slice(1)
        : env.RESIZED_IMAGE_PATH;

      if (resizedPathPrefix.endsWith('/')) {
        resizedPathPrefix = resizedPathPrefix.slice(0, -1);
      }

      if (
        resizedPathPrefix &&
        (pathWithoutSlash === resizedPathPrefix ||
          pathWithoutSlash.startsWith(`${resizedPathPrefix}/`))
      ) {
        logger.warn('Access on S3 Image Resizer Path Denied', {
          path: pathWithoutSlash,
          resizedPathPrefix,
        });
        ctx.set.status = 403;
        return {
          error: 'Forbidden',
          message: 'Access Denied',
        };
      }

      const imageId = pathWithoutSlash;
      //Set Image Format WebP if no format is provided
      const imageFormat = format || ('webp' as ImageFormats);

      //Set Force Resize Default to False
      const forceResize = force_resize === 'true' || false;

      // Parse dimensions
      const width = w ? parseInt(w) : null;
      const height = h ? parseInt(h) : null;

      let s3Key: string;
      let isProcessing = false;

      // If both dimensions provided, get/create variant
      if (width !== null && height !== null) {
        const result = await ImageService.getOrCreateVariant(
          imageId,
          width,
          height,
          imageFormat,
          forceResize,
          ip,
        );
        s3Key = result.s3Key;
        isProcessing = result.shouldStreamOriginal;
      }
      // If neither dimension provided, serve original
      else {
        s3Key = await ImageService.getOriginal(imageId);
      }

      // get public url
      const publicUrl = S3Service.getPublicUrl(s3Key);

      ctx.set.headers['X-Image-Status'] = isProcessing ? 'processing' : 'ready';
      // if image is original then do not cache it.
      if (isProcessing) {
        ctx.set.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      } else {
        ctx.set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      }
      ctx.set.status = 302; // Temporary redirect
      ctx.set.headers['Location'] = publicUrl;

      return null;
    } catch (error: any) {
      logger.error('Error serving image:', error);

      if (error.message.includes('not found')) {
        ctx.set.status = 404;
        return {
          error: 'Image not found',
          message: error.message,
        };
      }

      ctx.set.status = 500;
      return {
        error: 'Internal server error',
        message: 'Failed to process image request',
      };
    }
  }
  /**
   * Delete Image
   */
  static async deleteImage(ctx: Context) {
    try {
      const path = ctx.path;
      const pathWithoutSlash = path.startsWith('/') ? path.slice(1) : path;
      const queryResults = ImageQuerySchema.safeParse(ctx.query);

      if (!queryResults.success) {
        ctx.set.status = 400;
        return {
          error: 'Invalid query parameters or request',
          message: queryResults.error ? JSON.parse(queryResults.error.message) : 'Invalid request',
        };
      }

      const imageId = pathWithoutSlash;
      const { w, h } = ctx.query as { w?: string; h?: string };
      const { format } = ctx.query as { format?: ImageFormats };

      // Parse dimensions
      const width = w ? parseInt(w) : null;
      const height = h ? parseInt(h) : null;
      const imageFormat = format ?? null;

      await ImageService.deleteImage(imageId, width, height, imageFormat);
      return { message: 'Image deleted successfully' };
    } catch (error: any) {
      logger.error('Error deleting image:', error);
      ctx.set.status = 500;
      return {
        error: 'Internal server error',
        message: 'Failed to delete image',
      };
    }
  }
}
