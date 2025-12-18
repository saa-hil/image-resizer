import Redis from 'ioredis';
import { redisConnection } from '../config/cache';
import logger from '../utils/logger';

/**
 * Create a Redis client for health monitoring
 * This is separate from the BullMQ connection
 */
export const createRedisMonitor = (): Redis => {
  const redisMonitor = new Redis({
    host: redisConnection.host,
    port: redisConnection.port,
    password: redisConnection.password,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  // Setup event listeners for monitoring
  redisMonitor.on('error', (err) => {
    logger.error('Redis monitor connection error', {
      error: err.message,
      stack: err.stack,
      host: redisConnection.host,
      port: redisConnection.port,
    });
  });

  redisMonitor.on('close', () => {
    logger.warn('Redis monitor connection closed', {
      host: redisConnection.host,
      port: redisConnection.port,
    });
  });

  redisMonitor.on('reconnecting', (delay: number) => {
    logger.info('Redis monitor reconnecting...', {
      delay,
      host: redisConnection.host,
      port: redisConnection.port,
    });
  });

  redisMonitor.on('connect', () => {
    logger.info('Redis monitor connected', {
      host: redisConnection.host,
      port: redisConnection.port,
    });
  });

  redisMonitor.on('ready', () => {
    logger.info('Redis monitor ready', {
      host: redisConnection.host,
      port: redisConnection.port,
    });
  });

  redisMonitor.on('end', () => {
    logger.warn('Redis monitor connection ended');
  });

  return redisMonitor;
};

/**
 * Get Redis health information
 */
export const getRedisHealth = async (client: Redis) => {
  try {
    const start = Date.now();
    await client.ping();
    const pingTime = Date.now() - start;

    const info = await client.info();
    const lines = info.split('\r\n');

    const getStatValue = (key: string): string | undefined => {
      const line = lines.find((l) => l.startsWith(key));
      if (!line) {
        return undefined;
      }
      return line.split(':')[1];
    };

    return {
      status: 'healthy',
      pingTime: `${pingTime}ms`,
      version: getStatValue('redis_version') ?? 'unknown',
      uptime: getStatValue('uptime_in_seconds') ?? 'unknown',
      connectedClients: getStatValue('connected_clients') ?? 'unknown',
      usedMemory: getStatValue('used_memory_human') ?? 'unknown',
      usedMemoryPeak: getStatValue('used_memory_peak_human') ?? 'unknown',
      totalCommandsProcessed: getStatValue('total_commands_processed') ?? 'unknown',
    };
  } catch (error) {
    logger.error('Failed to get Redis health', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Periodically monitor Redis health
 */
export const startRedisHealthMonitoring = (
  client: Redis,
  intervalMs: number = 60000,
): NodeJS.Timeout => {
  logger.info('Starting Redis health monitoring', { intervalMs });

  const interval = setInterval(async () => {
    try {
      const health = await getRedisHealth(client);

      if (health.status === 'healthy') {
        logger.debug('Redis health check', health);
      } else {
        logger.error('Redis health check failed', health);
      }
    } catch (error) {
      logger.error('Redis health monitoring error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalMs);

  return interval;
};
