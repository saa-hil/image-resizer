import { type ConnectionOptions } from 'bullmq';
import { env } from './env';

export const redisConnection: ConnectionOptions = {
  host: env.REDIS_HOST || 'localhost',
  port: parseInt(env.REDIS_PORT || '6379'),
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required for BullMQ
};
