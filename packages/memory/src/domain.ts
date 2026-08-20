/** Stable memory domains that must never be inferred from model text. */
export type MemoryScopeV1 =
  | { readonly version: 1; readonly kind: 'companion-reality' }
  | { readonly version: 1; readonly kind: 'character-scene'; readonly sceneId: string }
  | {
      readonly version: 1
      readonly kind: 'campaign-branch'
      readonly campaignId: string
      readonly branchId: string
    }

/** Trusted host facts required for every archive read and mutation. */
export interface MemoryAccessContextV1 {
  readonly version: 1
  readonly ownerId: string
  readonly authority: string
  readonly scope: MemoryScopeV1
  readonly channelDisclosure: 'personal-only' | 'owner-confidential'
  readonly requestIntent: 'ordinary' | 'explicit-confidential-recall'
}

export type MemoryObservationSourceKind =
  | 'dsh-message'
  | 'governance-operation'
  | 'committed-fiction-event'
  | 'legacy-import'

/** Immutable evidence that explains how one scoped fact entered governance. */
export interface MemoryObservationV1 {
  readonly schemaVersion: 1
  readonly event: 'observation'
  readonly id: string
  readonly ownerId: string
  readonly authority: string
  readonly scope: MemoryScopeV1
  readonly source: { readonly kind: MemoryObservationSourceKind; readonly id: string }
  readonly observedAt: string
}

export type MemoryKind =
  | 'preference'
  | 'biographical'
  | 'boundary'
  | 'commitment'
  | 'relationship'
  | 'episode'
  | 'state'
  | 'summary'

export interface MemoryValidity {
  readonly recordedAt: string
  readonly validFrom?: string
  readonly validTo?: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  const sortedExpected = [...expected].toSorted()
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`${label} contains missing or unknown fields`)
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}

/** Strictly parse one versioned scope and reject missing or extra fields. */
export function parseMemoryScopeV1(value: unknown): MemoryScopeV1 {
  const input = object(value, 'memory scope')
  if (input.version !== 1) throw new TypeError('memory scope version must be 1')
  if (input.kind === 'companion-reality') {
    exactKeys(input, ['version', 'kind'], 'companion-reality scope')
    return { version: 1, kind: 'companion-reality' }
  }
  if (input.kind === 'character-scene') {
    exactKeys(input, ['version', 'kind', 'sceneId'], 'character-scene scope')
    return { version: 1, kind: 'character-scene', sceneId: identifier(input.sceneId, 'sceneId') }
  }
  if (input.kind === 'campaign-branch') {
    exactKeys(input, ['version', 'kind', 'campaignId', 'branchId'], 'campaign-branch scope')
    return {
      version: 1,
      kind: 'campaign-branch',
      campaignId: identifier(input.campaignId, 'campaignId'),
      branchId: identifier(input.branchId, 'branchId'),
    }
  }
  throw new TypeError('memory scope kind is unsupported')
}

/** Strictly parse host-established access facts. */
export function parseMemoryAccessContextV1(value: unknown): MemoryAccessContextV1 {
  const input = object(value, 'memory access context')
  exactKeys(input, [
    'version', 'ownerId', 'authority', 'scope', 'channelDisclosure', 'requestIntent',
  ], 'memory access context')
  if (input.version !== 1) throw new TypeError('memory access context version must be 1')
  if (input.channelDisclosure !== 'personal-only' && input.channelDisclosure !== 'owner-confidential') {
    throw new TypeError('memory channel disclosure is unsupported')
  }
  if (input.requestIntent !== 'ordinary' && input.requestIntent !== 'explicit-confidential-recall') {
    throw new TypeError('memory request intent is unsupported')
  }
  return {
    version: 1,
    ownerId: identifier(input.ownerId, 'ownerId'),
    authority: identifier(input.authority, 'authority'),
    scope: parseMemoryScopeV1(input.scope),
    channelDisclosure: input.channelDisclosure,
    requestIntent: input.requestIntent,
  }
}

/** Exact scope equality used before retrieval or governance. */
export function memoryScopeEquals(left: MemoryScopeV1, right: MemoryScopeV1): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'companion-reality') return true
  if (left.kind === 'character-scene') return left.sceneId === (right as Extract<MemoryScopeV1, { kind: 'character-scene' }>).sceneId
  const rightBranch = right as Extract<MemoryScopeV1, { kind: 'campaign-branch' }>
  return left.campaignId === rightBranch.campaignId && left.branchId === rightBranch.branchId
}

function sourceScopeKey(scope: MemoryScopeV1): readonly string[] {
  if (scope.kind === 'companion-reality') return [scope.kind]
  if (scope.kind === 'character-scene') return [scope.kind, scope.sceneId]
  return [scope.kind, scope.campaignId, scope.branchId]
}

/** Stable content-independent source key namespaced by all trusted identity facts. */
export function memorySourceKey(input: {
  readonly ownerId: string
  readonly authority: string
  readonly scope: MemoryScopeV1
  readonly source: { readonly kind: MemoryObservationSourceKind; readonly id: string }
}): string {
  return JSON.stringify([
    identifier(input.ownerId, 'ownerId'),
    identifier(input.authority, 'authority'),
    ...sourceScopeKey(parseMemoryScopeV1(input.scope)),
    parseMemoryObservationSourceKind(input.source.kind),
    identifier(input.source.id, 'source id'),
  ])
}

export function parseMemoryObservationSourceKind(value: unknown): MemoryObservationSourceKind {
  if (value === 'dsh-message' || value === 'governance-operation'
    || value === 'committed-fiction-event' || value === 'legacy-import') return value
  throw new TypeError('memory observation source kind is unsupported')
}

export function parseMemoryKind(value: unknown): MemoryKind {
  if (value === 'preference' || value === 'biographical' || value === 'boundary'
    || value === 'commitment' || value === 'relationship' || value === 'episode'
    || value === 'state' || value === 'summary') return value
  throw new TypeError('memory kind is unsupported')
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`)
  }
  return value
}

/** Validate record time facts without inventing unknown validity bounds. */
export function validateMemoryValidity(value: MemoryValidity): MemoryValidity {
  const recordedAt = isoTimestamp(value.recordedAt, 'recordedAt')
  const validFrom = value.validFrom === undefined ? undefined : isoTimestamp(value.validFrom, 'validFrom')
  const validTo = value.validTo === undefined ? undefined : isoTimestamp(value.validTo, 'validTo')
  if (validFrom !== undefined && validTo !== undefined && validTo < validFrom) {
    throw new TypeError('validTo must not be earlier than validFrom')
  }
  return { recordedAt, ...(validFrom === undefined ? {} : { validFrom }), ...(validTo === undefined ? {} : { validTo }) }
}

/** Data-level confidential disclosure gate applied before ranking. */
export function canDiscloseMemory(
  visibility: 'personal' | 'confidential',
  policy: Pick<MemoryAccessContextV1, 'channelDisclosure' | 'requestIntent'>,
): boolean {
  return visibility === 'personal'
    || (policy.channelDisclosure === 'owner-confidential'
      && policy.requestIntent === 'explicit-confidential-recall')
}

/** Whether a record is active at a trusted comparison time. */
export function isMemoryCurrentlyValid(
  value: Pick<MemoryValidity, 'validFrom' | 'validTo'>,
  now: string,
): boolean {
  const timestamp = isoTimestamp(now, 'current time')
  return (value.validFrom === undefined || value.validFrom <= timestamp)
    && (value.validTo === undefined || value.validTo >= timestamp)
}
