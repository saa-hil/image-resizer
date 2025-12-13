import { Elysia } from 'elysia';
import { ImageController } from '../controllers/image.controller';
import { rateLimit } from 'elysia-rate-limit';
import { env } from '../config/env';
import type { SocketAddress } from 'bun';
import type { Generator } from 'elysia-rate-limit';

const ipGenerator: Generator<{ ip: SocketAddress }> = (_req, _serv, { ip }) => {
  return `${_req.method}-${ip}`;
};

export const routes = new Elysia().group('', (app) =>
  app
    .use(
      rateLimit({
        duration: parseInt(env.RATE_LIMIT_DURATION),
        max: parseInt(env.RATE_LIMIT_MAX),
        generator: ipGenerator,
        scoping: 'local',
        responseCode: 429,
        responseMessage: 'Too many requests, please try again later',
        countFailedRequest: true,
      }),
    )
    .get('*', ImageController.getImage)
    .delete('*', ImageController.deleteImage),
);
