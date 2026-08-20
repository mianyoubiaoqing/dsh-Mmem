import { describe, expect, it } from 'vitest'
import {
  OwnerEligibilityPolicy,
  type OwnerEligibilityInputV1,
} from '../src/index.js'

const SESSION_ID = 'session-fixture'
const MESSAGE_ID = 'message-fixture'

function input(overrides: Partial<OwnerEligibilityInputV1> = {}): OwnerEligibilityInputV1 {
  return {
    version: 1,
    sourceKind: 'user',
    delegationDepth: 0,
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    identity: {
      version: 1,
      authority: 'local-dsh-host-rpc',
      authenticatedOwnerId: 'owner-fixture',
      sessionOwnerId: 'owner-fixture',
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
    },
    ...overrides,
  }
}

function policy(): OwnerEligibilityPolicy {
  return new OwnerEligibilityPolicy({
    version: 1,
    ownerId: 'owner-fixture',
    authorityAllowlist: ['local-dsh-host-rpc'],
  })
}

describe('OwnerEligibilityPolicy', () => {
  it('accepts only a bound authenticated Owner user message at depth zero', () => {
    const decision = policy().evaluate(input())

    expect(decision).toEqual({
      version: 1,
      eligible: true,
      ownerId: 'owner-fixture',
      authority: 'local-dsh-host-rpc',
    })
    expect(Object.isFrozen(decision)).toBe(true)
  })

  it.each([
    ['plugin', 'not-user-source'],
    ['tool', 'not-user-source'],
    ['model', 'not-user-source'],
  ] as const)('rejects %s source as %s', (sourceKind, reason) => {
    expect(policy().evaluate(input({ sourceKind }))).toEqual({
      version: 1,
      eligible: false,
      reason,
    })
  })

  it('rejects delegated sessions even when their prompt says user', () => {
    expect(policy().evaluate(input({ delegationDepth: 1 }))).toEqual({
      version: 1,
      eligible: false,
      reason: 'delegated-session',
    })
  })

  it.each([
    [undefined, 'delegation-depth-missing'],
    [-1, 'delegation-depth-invalid'],
    [1.5, 'delegation-depth-invalid'],
  ] as const)('fails closed for delegation depth %s', (delegationDepth, reason) => {
    expect(policy().evaluate(input({ delegationDepth }))).toEqual({
      version: 1,
      eligible: false,
      reason,
    })
  })

  it('rejects missing identity evidence', () => {
    expect(policy().evaluate(input({ identity: undefined }))).toEqual({
      version: 1,
      eligible: false,
      reason: 'identity-missing',
    })
  })

  it.each([
    ['authenticated owner', { authenticatedOwnerId: 'other-owner' }],
    ['session owner', { sessionOwnerId: 'other-owner' }],
    ['authority', { authority: 'untrusted-channel' }],
    ['session binding', { sessionId: 'other-session' }],
    ['message binding', { messageId: 'other-message' }],
  ])('rejects mismatched %s evidence', (_label, identityOverride) => {
    const identity = { ...input().identity!, ...identityOverride }

    expect(policy().evaluate(input({ identity }))).toEqual({
      version: 1,
      eligible: false,
      reason: 'identity-mismatch',
    })
  })
})
