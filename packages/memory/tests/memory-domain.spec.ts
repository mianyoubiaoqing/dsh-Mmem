import { describe, expect, it } from 'vitest'
import {
  canDiscloseMemory,
  memoryScopeEquals,
  memorySourceKey,
  parseMemoryAccessContextV1,
  parseMemoryScopeV1,
  validateMemoryValidity,
} from '../src/domain.js'

const companion = { version: 1, kind: 'companion-reality' } as const

describe('MemoryDomain', () => {
  it.each([
    companion,
    { version: 1, kind: 'character-scene', sceneId: 'scene-a' },
    { version: 1, kind: 'campaign-branch', campaignId: 'campaign-a', branchId: 'branch-1' },
  ] as const)('strictly accepts the supported scope $kind', scope => {
    expect(parseMemoryScopeV1(scope)).toEqual(scope)
  })

  it.each([
    {},
    { version: 1, kind: 'companion-reality', sceneId: 'extra' },
    { version: 1, kind: 'character-scene', sceneId: '' },
    { version: 1, kind: 'campaign-branch', campaignId: 'campaign-a' },
    { version: 1, kind: 'unknown' },
  ])('rejects malformed or authority-bearing scope data %#', value => {
    expect(() => parseMemoryScopeV1(value)).toThrow()
  })

  it('strictly parses trusted access context without accepting policy extensions', () => {
    const context = {
      version: 1,
      ownerId: 'owner-a',
      authority: 'local-dsh-host-rpc',
      scope: companion,
      channelDisclosure: 'personal-only',
      requestIntent: 'ordinary',
    } as const
    expect(parseMemoryAccessContextV1(context)).toEqual(context)
    expect(() => parseMemoryAccessContextV1({ ...context, allowAll: true })).toThrow()
    expect(() => parseMemoryAccessContextV1({ ...context, ownerId: '' })).toThrow()
  })

  it('binds source idempotency to owner, authority, exact scope, source kind and source id', () => {
    const base = {
      ownerId: 'owner-a',
      authority: 'local-dsh-host-rpc',
      scope: companion,
      source: { kind: 'dsh-message', id: 'message-1' },
    } as const
    const key = memorySourceKey(base)
    expect(memorySourceKey(base)).toBe(key)
    expect(memorySourceKey({ ...base, ownerId: 'owner-b' })).not.toBe(key)
    expect(memorySourceKey({ ...base, authority: 'loopback-settings-ui' })).not.toBe(key)
    expect(memorySourceKey({ ...base, scope: { version: 1, kind: 'character-scene', sceneId: 'scene-a' } })).not.toBe(key)
    expect(memorySourceKey({ ...base, source: { kind: 'governance-operation', id: 'message-1' } })).not.toBe(key)
  })

  it('compares every scope discriminator exactly', () => {
    expect(memoryScopeEquals(companion, companion)).toBe(true)
    expect(memoryScopeEquals(companion, { version: 1, kind: 'character-scene', sceneId: 'scene-a' })).toBe(false)
    expect(memoryScopeEquals(
      { version: 1, kind: 'campaign-branch', campaignId: 'campaign-a', branchId: 'branch-1' },
      { version: 1, kind: 'campaign-branch', campaignId: 'campaign-a', branchId: 'branch-2' },
    )).toBe(false)
  })

  it.each([
    ['personal-only', 'ordinary', false],
    ['personal-only', 'explicit-confidential-recall', false],
    ['owner-confidential', 'ordinary', false],
    ['owner-confidential', 'explicit-confidential-recall', true],
  ] as const)('hard-filters confidential for %s / %s', (channelDisclosure, requestIntent, expected) => {
    expect(canDiscloseMemory('personal', { channelDisclosure, requestIntent })).toBe(true)
    expect(canDiscloseMemory('confidential', { channelDisclosure, requestIntent })).toBe(expected)
  })

  it('validates strict ISO timestamps and ordered validity intervals without filling unknown bounds', () => {
    expect(validateMemoryValidity({ recordedAt: '2026-08-20T10:00:00.000Z' })).toEqual({
      recordedAt: '2026-08-20T10:00:00.000Z',
    })
    expect(() => validateMemoryValidity({ recordedAt: '2026-08-20' })).toThrow()
    expect(() => validateMemoryValidity({
      recordedAt: '2026-08-20T10:00:00.000Z',
      validFrom: '2026-08-21T00:00:00.000Z',
      validTo: '2026-08-20T00:00:00.000Z',
    })).toThrow()
  })
})
