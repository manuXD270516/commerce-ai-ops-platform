import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { ApiConfig } from './config.js';
import { API_CONFIG } from './config.js';
import { CatalogController } from './catalog.controller.js';
import { CommerceController } from './commerce.controller.js';
import { DEPENDENCY_PROBE, PostgresRedisProbe, type DependencyProbe } from './dependency-probe.js';
import { DomainExceptionFilter } from './domain.filter.js';
import { DOMAIN, DomainService } from './domain.service.js';
import { HealthController } from './health.controller.js';
import {
  InlineRunDispatcher,
  QueueRunDispatcher,
  RUN_DISPATCHER,
  type RunDispatcher,
} from './run-dispatcher.js';
import { RunsController } from './runs.controller.js';
import { StatusController } from './status.controller.js';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(DEPENDENCY_PROBE) private readonly probe: DependencyProbe,
    @Inject(RUN_DISPATCHER) private readonly dispatcher: RunDispatcher,
  ) {}

  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        StatusController,
        CatalogController,
        CommerceController,
        RunsController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        {
          provide: DEPENDENCY_PROBE,
          useFactory: () => new PostgresRedisProbe(config.databaseUrl, config.redisUrl),
        },
        {
          provide: DOMAIN,
          useFactory: () => new DomainService(config.databaseUrl, config.auth),
        },
        {
          provide: RUN_DISPATCHER,
          inject: [DOMAIN],
          useFactory: (domain: DomainService): RunDispatcher => {
            if (config.runExecution === 'queue' && config.redisUrl) {
              return new QueueRunDispatcher(config.redisUrl);
            }
            if (domain.db) return new InlineRunDispatcher(domain.db);
            return {
              dispatch: () => Promise.resolve(),
              close: () => Promise.resolve(),
            };
          },
        },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispatcher.close();
    await this.probe.close();
  }
}
