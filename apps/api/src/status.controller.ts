import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { ServiceStatus } from '@commerce/contracts';
import type { Request } from 'express';
import { API_CONFIG, type ApiConfig } from './config.js';
import { correlationIdOf } from './http-logging.js';

@Controller('v1')
export class StatusController {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  @Get('status')
  status(@Req() req: Request): ServiceStatus {
    return {
      service: 'api',
      version: this.config.version,
      status: 'ok',
      correlation_id: correlationIdOf(req),
      observed_at: new Date().toISOString(),
    };
  }
}
