import { AccessTokenError, AUDIENCES, bearerToken, verifyAccessToken } from '@commerce/contracts';
import {
  createDb,
  createPool,
  DomainError,
  isDomainError,
  resolveActor,
  type ActorContext,
  type DomainDb,
} from '@commerce/domain';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthConfig } from './config.js';
import { correlationIdOf } from './http-logging.js';

export const DOMAIN = Symbol('DOMAIN');

@Injectable()
export class DomainService implements OnModuleDestroy {
  readonly db: DomainDb | undefined;

  constructor(
    databaseUrl: string | undefined,
    private readonly auth: AuthConfig | undefined,
  ) {
    this.db = databaseUrl ? createDb(createPool(databaseUrl)) : undefined;
  }

  /** Tenant and subject come only from a verified token; the role comes from the membership row. */
  async actorOf(req: Request): Promise<ActorContext> {
    const token = bearerToken(req.headers.authorization);
    if (!token || !this.auth) throw new DomainError('UNAUTHENTICATED', 'Bearer token required');
    let identity;
    try {
      identity = verifyAccessToken(token, {
        issuer: this.auth.issuer,
        audience: AUDIENCES.api,
        jwks: this.auth.jwks,
      });
    } catch (error) {
      if (error instanceof AccessTokenError) {
        throw new DomainError('UNAUTHENTICATED', 'Invalid or expired token');
      }
      throw error;
    }
    return resolveActor(this.requireDb(), {
      tenantId: identity.tenantId,
      subjectId: identity.subject,
      correlationId: correlationIdOf(req),
    });
  }

  requireDb(): DomainDb {
    if (!this.db) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'DATABASE_URL is not configured');
    return this.db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.db?.destroy();
  }
}

export function mapErrorStatus(error: unknown): number {
  if (!isDomainError(error)) return 500;
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'VALIDATION_ERROR':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'CONFLICT':
    case 'APPROVAL_REQUIRED':
      return 409;
    case 'BUDGET_EXCEEDED':
      return 429;
    case 'DEPENDENCY_UNAVAILABLE':
      return 503;
  }
}
