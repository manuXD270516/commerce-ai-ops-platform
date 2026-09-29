import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger, shutdownTracing } from '@commerce/telemetry';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { httpLogging } from './http-logging.js';
import { NestPinoLogger } from './nest-logger.js';

const config = loadConfig();
const logger = createLogger({ service: 'api' });

const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
  logger: new NestPinoLogger(logger),
});
app.disable('x-powered-by');
app.use(httpLogging(logger));
app.enableShutdownHooks();

await app.listen(config.port, config.host);
logger.info({ host: config.host, port: config.port, version: config.version }, 'api ready');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdownTracing().finally(() => {
      logger.info({ signal }, 'api stopping');
    });
  });
}
