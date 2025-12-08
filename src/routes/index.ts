import { Elysia, t } from 'elysia';
import { ImageController } from '../controllers/image.controller';

export const routes = new Elysia()
  .get('*', ImageController.getImage)
  .delete('*', ImageController.deleteImage);
