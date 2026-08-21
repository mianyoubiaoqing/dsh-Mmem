/** Versioned per-Memory-Space policy for automatic Source Turn compression. */
export type MemoryTurnSummaryPolicyV1 =
  | {
      readonly schemaVersion: 1
      readonly revision: number
      readonly mode: 'local-deterministic'
    }
  | {
      readonly schemaVersion: 1
      readonly revision: number
      readonly mode: 'dsh-model'
      readonly provider?: string
      readonly model?: string
    }

/** Owner-authored exact-revision replacement for one Space policy. */
export type MemoryTurnSummaryPolicyUpdateV1 =
  | {
      readonly expectedRevision: number
      readonly mode: 'local-deterministic'
    }
  | {
      readonly expectedRevision: number
      readonly mode: 'dsh-model'
      readonly provider?: string
      readonly model?: string
    }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  const keys = [...expected].toSorted()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${label} contains missing or unknown fields`)
  }
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function route(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new TypeError(`turn summary ${label} must be a bounded non-empty string`)
  }
  return value.trim()
}

/** Safe default that performs no additional model call or disclosure. */
export function defaultMemoryTurnSummaryPolicyV1(): MemoryTurnSummaryPolicyV1 {
  return { schemaVersion: 1, revision: 0, mode: 'local-deterministic' }
}

/** Strictly parse a persisted per-Space summary policy. */
export function parseMemoryTurnSummaryPolicyV1(value: unknown): MemoryTurnSummaryPolicyV1 {
  const input = object(value, 'turn summary policy')
  if (input.schemaVersion !== 1) throw new TypeError('turn summary policy schemaVersion must equal 1')
  const policyRevision = revision(input.revision, 'turn summary policy revision')
  if (input.mode === 'local-deterministic') {
    exactKeys(input, ['schemaVersion', 'revision', 'mode'], 'local turn summary policy')
    return { schemaVersion: 1, revision: policyRevision, mode: 'local-deterministic' }
  }
  if (input.mode === 'dsh-model') {
    exactKeys(input, [
      'schemaVersion',
      'revision',
      'mode',
      ...(input.provider === undefined ? [] : ['provider']),
      ...(input.model === undefined ? [] : ['model']),
    ], 'model turn summary policy')
    const provider = route(input.provider, 'provider')
    const model = route(input.model, 'model')
    return {
      schemaVersion: 1,
      revision: policyRevision,
      mode: 'dsh-model',
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    }
  }
  throw new TypeError('turn summary policy mode is unsupported')
}

/** Strictly parse an untrusted Settings update. */
export function parseMemoryTurnSummaryPolicyUpdateV1(value: unknown): MemoryTurnSummaryPolicyUpdateV1 {
  const input = object(value, 'turn summary policy update')
  const expectedRevision = revision(input.expectedRevision, 'turn summary policy expectedRevision')
  if (input.mode === 'local-deterministic') {
    exactKeys(input, ['expectedRevision', 'mode'], 'local turn summary policy update')
    return { expectedRevision, mode: 'local-deterministic' }
  }
  if (input.mode === 'dsh-model') {
    exactKeys(input, [
      'expectedRevision',
      'mode',
      ...(input.provider === undefined ? [] : ['provider']),
      ...(input.model === undefined ? [] : ['model']),
    ], 'model turn summary policy update')
    const provider = route(input.provider, 'provider')
    const model = route(input.model, 'model')
    return {
      expectedRevision,
      mode: 'dsh-model',
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    }
  }
  throw new TypeError('turn summary policy update mode is unsupported')
}
