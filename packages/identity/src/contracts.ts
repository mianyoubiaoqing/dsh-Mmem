/** Identity evidence bound to one durable message in one DSH Session. */
export interface OwnerIdentityEvidenceV1 {
  readonly version: 1
  readonly authority: string
  readonly authenticatedOwnerId: string
  readonly sessionOwnerId: string
  readonly sessionId: string
  readonly messageId: string
}

/** Canonical facts evaluated by the shared Owner Eligibility policy. */
export interface OwnerEligibilityInputV1 {
  readonly version: 1
  readonly sourceKind: string
  readonly delegationDepth?: number
  readonly sessionId: string
  readonly messageId: string
  readonly identity?: OwnerIdentityEvidenceV1
}

/** Trusted owner and channel authorities accepted by one deployment. */
export interface OwnerEligibilityPolicyConfigV1 {
  readonly version: 1
  readonly ownerId: string
  readonly authorityAllowlist: readonly string[]
}

/** Stable fail-closed causes; callers never infer eligibility from text. */
export type OwnerIneligibilityReasonV1 =
  | 'not-user-source'
  | 'delegated-session'
  | 'delegation-depth-missing'
  | 'delegation-depth-invalid'
  | 'identity-missing'
  | 'identity-mismatch'
  | 'no-active-owner-turn'

/** Frozen policy result shared by Foundation, Memory and future channel adapters. */
export type OwnerEligibilityDecisionV1 = {
  readonly version: 1
  readonly eligible: true
  readonly ownerId: string
  readonly authority: string
} | {
  readonly version: 1
  readonly eligible: false
  readonly reason: OwnerIneligibilityReasonV1
}
