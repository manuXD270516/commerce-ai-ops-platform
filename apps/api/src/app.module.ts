import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiConfig } from './config.js';
import { API_CONFIG } from './config.js';
import { DEPENDENCY_PROBE, PostgresRedisProbe, type DependencyProbe } from './dependency-probe.js';
import { HealthController } from './health.controller.js';
import { StatusController } from './status.controller.js';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DEPENDENCY_PROBE) private readonly probe: DependencyProbe) {}

  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, StatusController],
      providers: [
        { provide: API_CONFIG, useValue: config },
        {
          provide: DEPENDENCY_PROBE,
          useFactory: () => new PostgresRedisProbe(config.databaseUrl, config.redisUrl),
        },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.probe.close();
  }
}
