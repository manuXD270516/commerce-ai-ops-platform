import {
  createDb,
  createPool,
  isDomainError,
  resolveActor,
  resolveTenantId,
  type ActorContext,
  type DomainDb,
} from '@commerce/domain';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '@commerce/domain';
import { correlationIdOf } from './http-logging.js';

export const DOMAIN = Symbol('DOMAIN');

@Injectable()
export class DomainService implements OnModuleDestroy {
  readonly db: DomainDb | undefined;
  private readonly pool;

  constructor(databaseUrl: string | undefined) {
    this.pool = databaseUrl ? createPool(databaseUrl) : undefined;
    this.db = this.pool ? createDb(this.pool) : undefined;
  }

  async actorOf(req: Request): Promise<ActorContext> {
    if (!this.db) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'DATABASE_URL is not configured');
    const tenantRaw = header(req, 'x-tenant-id');
    const subjectId = header(req, 'x-subject-id');
    if (!tenantRaw || !subjectId) {
      throw new DomainError('FORBIDDEN', 'X-Tenant-Id and X-Subject-Id are required');
    }
    const tenantId = await resolveTenantId(this.db, tenantRaw);
    return resolveActor(this.db, {
      tenantId,
      subjectId,
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
    default:
      return 500;
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
