import { Elysia, t } from 'elysia';
import { ImageController } from '../controllers/image.controller';

export const routes = new Elysia({ prefix: '/images' })
  .get('/:imageId', ImageController.getImage)
  .delete('/:imageId', ImageController.deleteImage);
