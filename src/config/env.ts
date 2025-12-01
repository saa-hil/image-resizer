import { z } from 'zod';

const envSchema = z.object({
  APP_PORT: z.string().default('3000'),
  MONGODB_URI: z.string().min(1, 'MongoDB URI is required'),
  DB_NAME: z.string().default('myapp'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  AWS_REGION: z.string().default('ap-south-1'),
  S3_BUCKET_NAME: z.string().default('image-resizer-1764492037'),
  AWS_ACCESS_KEY_ID: z.string().default('AKIAVJWJWJWJWJWJWJWJ'),
  AWS_SECRET_ACCESS_KEY: z.string().default('AKIAVJWJWJWJWJWJWJWJ'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379'),
  REDIS_PASSWORD: z.string().default(''),
});

const parseEnv = () => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    console.error('❌ Invalid environment variables:');
    if (error instanceof z.ZodError) {
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
    }
    process.exit(1);
  }
};

export const env = parseEnv();