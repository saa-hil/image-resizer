import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { helmet } from 'elysia-helmet';
import { connectDB, closeDB } from './config/db';
import { routes } from './routes/index'; // Rate limiting is inside routes
import { env } from './config/env';
import { ip } from 'elysia-ip';

const app = new Elysia()
  .use(
    cors({
      origin: env.ALLOWED_ORIGINS.split(','),
      credentials: true,
    }),
  )
  .use(helmet())
  .use(
    ip({
      checkHeaders: [
        'CF-Connecting-IP',
        'X-Real-IP',
        'x-client-ip',
        'x-cluster-client-ip',
        'Forwarded-For',
        'True-Client-IP',
        'appengine-user-ip',
        'cf-pseudo-ipv4',
        'forwarded',
        'x-forwarded',
        'X-Forwarded-For',
      ],
    }),
  )
  .onStart(async () => {
    await connectDB();
    console.log(`Server running on port ${env.APP_PORT}`);
  })
  .onStop(async () => {
    await closeDB();
    console.log('Database connection closed');
  })
  .get('/health', () => ({ status: 'ok', timestamp: new Date().toISOString() }))
  .get('/ip', ({ ip }: { ip: string }) => ({ ip }))
  .use(routes)
  .onError(({ code, error, set }) => {
    console.error('Error:', error);
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Route not found' };
    }

    set.status = 500;
    return { error: 'Internal server error' };
  })
  .listen({
    hostname: '0.0.0.0',
    port: env.APP_PORT,
  });

console.log(`Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await app.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await app.stop();
  process.exit(0);
});

export type App = typeof app;
