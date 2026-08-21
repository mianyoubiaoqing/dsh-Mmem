/** Versioned Owner policy controlling whether pending Candidates require manual review. */
export type MemoryApprovalPolicyV1 = {
  schemaVersion: 1
  revision: number
  mode: 'manual'
} | {
  schemaVersion: 1
  revision: number
  mode: 'scheduled-auto'
  timeZone: string
  localTime: string
}

/** Owner update guarded by the exact previously observed policy revision. */
export type MemoryApprovalPolicyUpdateV1 = {
  expectedRevision: number
  mode: 'manual'
} | {
  expectedRevision: number
  mode: 'scheduled-auto'
  timeZone: string
  localTime: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  const keys = [...expected].toSorted()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} contains missing or unknown fields`)
  }
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function timeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('memory approval timeZone must be a non-empty IANA time zone')
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    throw new Error('memory approval timeZone must be a valid IANA time zone')
  }
}

function localTime(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new Error('memory approval localTime must use 24-hour HH:mm')
  }
  return value
}

/** Return the default daily automatic-review policy used before the Owner creates settings. */
export function defaultMemoryApprovalPolicyV1(): MemoryApprovalPolicyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    mode: 'scheduled-auto',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: '03:00',
  }
}

/** Parse one untrusted persisted approval policy into its canonical form. */
export function parseMemoryApprovalPolicyV1(value: unknown): MemoryApprovalPolicyV1 {
  if (value === undefined) return defaultMemoryApprovalPolicyV1()
  const record = object(value, 'memory settings approvalPolicy')
  if (record.schemaVersion !== 1) throw new Error('memory approval policy schemaVersion must equal 1')
  const policyRevision = revision(record.revision, 'memory approval policy revision')
  if (record.mode === 'manual') {
    exactKeys(record, ['schemaVersion', 'revision', 'mode'], 'memory manual approval policy')
    return { schemaVersion: 1, revision: policyRevision, mode: 'manual' }
  }
  if (record.mode === 'scheduled-auto') {
    exactKeys(
      record,
      ['schemaVersion', 'revision', 'mode', 'timeZone', 'localTime'],
      'memory scheduled approval policy',
    )
    return {
      schemaVersion: 1,
      revision: policyRevision,
      mode: 'scheduled-auto',
      timeZone: timeZone(record.timeZone),
      localTime: localTime(record.localTime),
    }
  }
  throw new Error('memory approval policy mode must be manual or scheduled-auto')
}

/** Parse one untrusted exact-revision policy update. */
export function parseMemoryApprovalPolicyUpdateV1(value: unknown): MemoryApprovalPolicyUpdateV1 {
  const record = object(value, 'memory approval policy update')
  const expectedRevision = revision(record.expectedRevision, 'memory approval expectedRevision')
  if (record.mode === 'manual') {
    exactKeys(record, ['expectedRevision', 'mode'], 'memory manual approval update')
    return { expectedRevision, mode: 'manual' }
  }
  if (record.mode === 'scheduled-auto') {
    exactKeys(
      record,
      ['expectedRevision', 'mode', 'timeZone', 'localTime'],
      'memory scheduled approval update',
    )
    return {
      expectedRevision,
      mode: 'scheduled-auto',
      timeZone: timeZone(record.timeZone),
      localTime: localTime(record.localTime),
    }
  }
  throw new Error('memory approval update mode must be manual or scheduled-auto')
}
