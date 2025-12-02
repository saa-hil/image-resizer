import sharp from 'sharp';
import { z } from 'zod';

async function getContentType(buffer: Buffer): Promise<string> {
  const metadata = await sharp(buffer).metadata();
  const format = metadata.format;
  const contentTypeMap: Record<string, string> = {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };

  return contentTypeMap[format] || 'image/webp';
}

//Zod Validations For Images
const ImageQuerySchema = z
  .object({
    w: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : null))
      .refine((val) => val === null || (!isNaN(val) && val > 0 && val <= 5000), {
        message: 'Width must be a positive integer between 1 and 5000',
      }),
    h: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : null))
      .refine((val) => val === null || (!isNaN(val) && val > 0 && val <= 5000), {
        message: 'Height must be a positive integer between 1 and 5000',
      }),
    format: z
      .enum(['jpeg', 'jpg', 'png', 'webp'])
      .optional()
      .default('webp')
      .refine(
        (val) => val === null || val === 'webp' || val === 'jpeg' || val === 'jpg' || val === 'png',
        {
          message: 'Invalid image requested format',
        },
      ),
    force_resize: z
      .string()
      .optional()
      .default('false')
      .refine((val) => val === 'true' || val === 'false', {
        message: 'Force resize must be true or false',
      }),
  })
  .refine(
    (data) => {
      // Both must be provided or both must be null
      const bothProvided = data.w !== null && data.h !== null;
      const neitherProvided = data.w === null && data.h === null;
      return bothProvided || neitherProvided;
    },
    {
      message: 'Both width and height are required, or provide neither',
    },
  );

const ImageParamsSchema = z.object({
  imageId: z
    .string()
    .min(1, 'Image ID is required')
    .regex(/^[\w\-\.]+$/, 'Invalid image ID format'),
});

export { getContentType, ImageQuerySchema, ImageParamsSchema };
