import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import type { ApiError } from '@commerce/contracts';
import { isDomainError } from '@commerce/domain';
import type { Request, Response } from 'express';
import { correlationIdOf } from './http-logging.js';
import { mapErrorStatus } from './domain.service.js';

/** Every error leaves the API in the stable error.schema.json shape; internals are never echoed. */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const correlationId = correlationIdOf(ctx.getRequest<Request>());
    const send = (status: number, code: ApiError['code'], message: string) => {
      const body: ApiError = { code, message, correlation_id: correlationId };
      res.status(status).json(body);
    };
    if (isDomainError(error)) {
      send(mapErrorStatus(error), error.code, error.message);
      return;
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === 404) send(404, 'NOT_FOUND', 'Route not found');
      else if (status === 401) send(401, 'UNAUTHENTICATED', 'Authentication required');
      else if (status === 403) send(403, 'FORBIDDEN', 'Forbidden');
      else if (status < 500) send(400, 'VALIDATION_ERROR', 'Invalid request');
      else send(503, 'DEPENDENCY_UNAVAILABLE', 'Service unavailable');
      return;
    }
    send(500, 'DEPENDENCY_UNAVAILABLE', 'Internal error');
  }
}
