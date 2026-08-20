import type {
  OwnerEligibilityDecisionV1,
  OwnerEligibilityInputV1,
  OwnerEligibilityPolicyConfigV1,
  OwnerIneligibilityReasonV1,
} from './contracts.js'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/

function identifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`${field} must be a non-path identifier.`)
  return value
}

function rejected(reason: OwnerIneligibilityReasonV1): OwnerEligibilityDecisionV1 {
  return Object.freeze({ version: 1, eligible: false, reason })
}

/** Evaluates canonical source, depth and bound identity facts without DSH side effects. */
export class OwnerEligibilityPolicy {
  readonly #ownerId: string
  readonly #authorities: ReadonlySet<string>

  constructor(config: OwnerEligibilityPolicyConfigV1) {
    if (config.version !== 1) throw new TypeError('Owner Eligibility policy version must be 1.')
    this.#ownerId = identifier(config.ownerId, 'ownerId')
    this.#authorities = new Set(config.authorityAllowlist.map((authority) =>
      identifier(authority, 'authorityAllowlist entry')))
    if (this.#authorities.size === 0) throw new TypeError('authorityAllowlist must not be empty.')
  }

  /** Returns a frozen decision; every missing or mismatched fact is denied. */
  evaluate(input: OwnerEligibilityInputV1): OwnerEligibilityDecisionV1 {
    if (input.sourceKind !== 'user') return rejected('not-user-source')
    if (input.delegationDepth === undefined) return rejected('delegation-depth-missing')
    if (!Number.isSafeInteger(input.delegationDepth) || input.delegationDepth < 0) {
      return rejected('delegation-depth-invalid')
    }
    if (input.delegationDepth > 0) return rejected('delegated-session')
    const identity = input.identity
    if (identity === undefined) return rejected('identity-missing')
    if (identity.version !== 1
      || !this.#authorities.has(identity.authority)
      || identity.authenticatedOwnerId !== this.#ownerId
      || identity.sessionOwnerId !== this.#ownerId
      || identity.sessionId !== input.sessionId
      || identity.messageId !== input.messageId) {
      return rejected('identity-mismatch')
    }
    return Object.freeze({
      version: 1,
      eligible: true,
      ownerId: this.#ownerId,
      authority: identity.authority,
    })
  }
}
