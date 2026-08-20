import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DshOwnerEligibilityService } from './dsh-owner-eligibility.js'

export type {
  OwnerEligibilityDecisionV1,
  OwnerEligibilityInputV1,
  OwnerEligibilityPolicyConfigV1,
  OwnerIdentityEvidenceV1,
  OwnerIneligibilityReasonV1,
} from './contracts.js'
export { OwnerEligibilityPolicy } from './owner-eligibility-policy.js'
export {
  DshOwnerEligibilityService,
  LOCAL_DSH_HOST_RPC_AUTHORITY,
} from './dsh-owner-eligibility.js'
export type { DshOwnerEligibilityConfig } from './dsh-owner-eligibility.js'

/** Cordis plugin name. */
export const name = 'mistymoon-identity'

/** Identity has no runtime service dependencies. */
export const inject: readonly string[] = []

/** Local deployment identity configuration. */
export interface Config {
  /** Stable non-path identifier for the single Owner of this loopback deployment. */
  ownerId: string
}

/** Runtime schema for the Identity plugin. */
export const Config: z<Config> = z.object({
  ownerId: z.string().required(),
})

/** Provides the single shared fail-closed Owner Eligibility service. */
export function apply(ctx: Context, config: Config): void {
  const service = new DshOwnerEligibilityService(config)
  ctx.effect(
    () => ctx.provide('mistymoonOwnerEligibility', service),
    'mistymoon-identity: Owner Eligibility service',
  )
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared Owner Eligibility decision service for RP and memory governance. */
    mistymoonOwnerEligibility: DshOwnerEligibilityService
  }
}
