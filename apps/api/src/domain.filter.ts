import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { isDomainError } from '@commerce/domain';
import type { Request, Response } from 'express';
import { correlationIdOf } from './http-logging.js';
import { mapErrorStatus } from './domain.service.js';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = correlationIdOf(req);
    if (isDomainError(error)) {
      res.status(mapErrorStatus(error)).json({
        code: error.code,
        message: error.message,
        correlation_id: correlationId,
      });
      return;
    }
    res.status(500).json({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'Internal error',
      correlation_id: correlationId,
    });
  }
}
