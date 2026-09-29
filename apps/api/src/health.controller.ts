import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { HealthReport } from '@commerce/contracts';
import type { Response } from 'express';
import { API_CONFIG, type ApiConfig } from './config.js';
import { DEPENDENCY_PROBE, type DependencyProbe } from './dependency-probe.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DEPENDENCY_PROBE) private readonly probe: DependencyProbe,
  ) {}

  @Get('healthz')
  liveness(): HealthReport {
    return this.report('ok', []);
  }

  @Get('readyz')
  async readiness(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const checks = await this.probe.check();
    const ready = checks.every((check) => check.status === 'up');
    res.status(ready ? 200 : 503);
    return this.report(ready ? 'ok' : 'unavailable', checks);
  }

  private report(status: HealthReport['status'], checks: HealthReport['checks']): HealthReport {
    return {
      status,
      service: 'api',
      version: this.config.version,
      observed_at: new Date().toISOString(),
      checks,
    };
  }
}
