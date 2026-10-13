import { MODEL_CAPABILITY } from '@cherrystudio/provider-registry';

import { modelService } from '@/backend/data/services/ModelService';

import type { RuntimeModel } from '..';
import { errorRecord, type PiStreamErrorEvent } from './piStreamEvents';

/** How many alternative models a single turn may fall back through. */
const MAX_FALLBACK_MODELS = 3;
/** The derived candidate list is reused briefly so a turn does not re-read the database. */
const FALLBACK_CACHE_MS = 30_000;
/** HTTP statuses that mean "too many requests" rather than "your request was wrong". */
const QUOTA_STATUSES = new Set([402, 429]);
/** Provider error codes that describe an exhausted quota or an overloaded endpoint. */
const QUOTA_CODES = new Set([
  'rate_limit',
  'rate_limited',
  'rate_limit_exceeded',
  'ratelimitexceeded',
  'requests_per_minute_exceeded',
  'quota',
  'quota_exceeded',
  'insufficient_quota',
  'resource_exhausted',
  'too_many_requests',
  'overloaded',
  'capacity',
]);
const QUOTA_MESSAGE =
  /rate.?limit|quota|too many requests|resource.?exhausted|overloaded|capacity|temporarily unavailable/i;

type Cache = { at: number; models: RuntimeModel[] };
let cache: Cache | undefined;

/**
 * Quota and rate-limit failures are the only ones that switch models. A malformed
 * request or a network blip must not silently move a conversation to a different
 * provider, so those keep the existing per-credential retry and then surface.
 */
export function isQuotaFailure(failure: PiStreamErrorEvent): boolean {
  const diagnostic = failure.error.diagnostics?.findLast(
    (entry) => entry.type === 'provider_response_failure',
  );
  if (!diagnostic) return false;

  const status = diagnostic.details?.statusCode ?? diagnostic.details?.status;
  if (typeof status === 'number' || (typeof status === 'string' && /^\d{3}$/.test(status))) {
    if (QUOTA_STATUSES.has(Number(status))) return true;
  }

  let body = diagnostic.details?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      // A non-JSON body still gets the message scan below.
    }
  }
  const record = errorRecord(body);
  const nested = errorRecord(record?.error) ?? record;
  const codes = [
    diagnostic.error?.code,
    nested?.code,
    nested?.status,
    nested?.statusCode,
    record?.code,
  ];
  if (codes.some((code) => typeof code === 'string' && QUOTA_CODES.has(code.toLowerCase())))
    return true;

  return [diagnostic.error?.message, nested?.message, record?.message].some(
    (value) => typeof value === 'string' && QUOTA_MESSAGE.test(value),
  );
}

/**
 * Models to try after the requested one is rate limited. The list is every other
 * enabled model that can call tools, preferring providers other than the one that
 * just failed, and is capped so a single turn cannot fan out across the account.
 */
export async function resolveFallbackModels(primary: RuntimeModel): Promise<RuntimeModel[]> {
  const now = Date.now();
  if (!cache || now - cache.at > FALLBACK_CACHE_MS) {
    try {
      const models = await modelService.list({
        capability: MODEL_CAPABILITY.FUNCTION_CALL,
        enabled: true,
      });
      cache = {
        at: now,
        models: models.map((model) => ({
          modelId: model.modelId,
          providerId: model.providerId,
        })),
      };
    } catch {
      // Fallback is optional; without it the requested model still runs.
      cache = { at: now, models: [] };
    }
  }

  const candidates = cache.models.filter(
    (model) =>
      !(model.providerId === primary.providerId && model.modelId === primary.modelId) &&
      model.modelId.length > 0,
  );
  // Another provider first: the failure was a quota on this one.
  const crossProvider = candidates.filter((model) => model.providerId !== primary.providerId);
  const sameProvider = candidates.filter((model) => model.providerId === primary.providerId);
  return [...crossProvider, ...sameProvider].slice(0, MAX_FALLBACK_MODELS);
}

/** Only used by tests and diagnostics; the production path relies on the TTL above. */
export function clearFallbackModelCache(): void {
  cache = undefined;
}
