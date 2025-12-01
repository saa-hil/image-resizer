import { type Context } from 'elysia';
import { ImageService } from '../services/image.service';
import { S3Service } from '../services/s3.service';
import { ImageParamsSchema, ImageQuerySchema } from '../utils/helpers';

export class ImageController {
  /**
   * Handle image request
   * GET /images/:imageId?w=800&h=600
   */
  static async getImage(ctx: Context) {
    try {
      const paramsResults = ImageParamsSchema.safeParse(ctx.params);
      const queryResults = ImageQuerySchema.safeParse(ctx.query);

      if (!paramsResults.success || !queryResults.success) {
        ctx.set.status = 400;
        return {
          error: 'Invalid query parameters or request',
          message: queryResults.error ? queryResults.error.message : 'Invalid request',
        };
      }

      const { imageId } = ctx.params as { imageId: string };
      const { w, h } = ctx.query as { w?: string; h?: string };

      // Parse dimensions
      const width = w ? parseInt(w) : null;
      const height = h ? parseInt(h) : null;

      let s3Key: string;
      let isProcessing = false;

      // If both dimensions provided, get/create variant
      if (width !== null && height !== null) {
        const result = await ImageService.getOrCreateVariant(imageId, width, height);
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
      ctx.set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      ctx.set.status = 302; // Temporary redirect
      ctx.set.headers['Location'] = publicUrl;

      return null;
    } catch (error: any) {
      console.error('Error serving image:', error);

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
}
