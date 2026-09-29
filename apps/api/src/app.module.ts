import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiConfig } from './config.js';
import { API_CONFIG } from './config.js';
import { DEPENDENCY_PROBE, PostgresRedisProbe, type DependencyProbe } from './dependency-probe.js';
import { DOMAIN, DomainService } from './domain.service.js';
import { DomainExceptionFilter } from './domain.filter.js';
import { APP_FILTER } from '@nestjs/core';
import { HealthController } from './health.controller.js';
import { StatusController } from './status.controller.js';
import { CatalogController } from './catalog.controller.js';
import { CommerceController } from './commerce.controller.js';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DEPENDENCY_PROBE) private readonly probe: DependencyProbe) {}

  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, StatusController, CatalogController, CommerceController],
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
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.probe.close();
  }
}
