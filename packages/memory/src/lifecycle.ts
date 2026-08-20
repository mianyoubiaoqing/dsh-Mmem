export interface DerivedMemoryViewInvalidationRequestV1 {
  readonly schemaVersion: 1
  readonly memoryIds: readonly string[]
}

/** Payload-free outcome; stale means the disposable view must be rebuilt. */
export interface DerivedMemoryViewInvalidationReceiptV1 {
  readonly providerId: string
  readonly providerVersion: string
  readonly status: 'current' | 'stale'
  readonly reason?: 'failed' | 'timed-out'
}

/** External derived index boundary; Providers never receive memory content or trusted context. */
export interface DerivedMemoryViewProviderV1 {
  readonly id: string
  readonly version: string
  readonly timeoutMs: number
  invalidate(
    request: DerivedMemoryViewInvalidationRequestV1,
    signal: AbortSignal,
  ): Promise<unknown> | unknown
}

export interface DerivedMemoryViewInvalidator {
  invalidate(
    memoryIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly DerivedMemoryViewInvalidationReceiptV1[]>
}

interface RegisteredDerivedView {
  readonly provider: DerivedMemoryViewProviderV1
}

/** Broadcasts payload-free invalidation while containing disposable Provider failures. */
export class DerivedMemoryViewRegistry implements DerivedMemoryViewInvalidator {
  readonly #registered = new Map<string, RegisteredDerivedView>()

  register(provider: DerivedMemoryViewProviderV1): () => void {
    if (provider.id.trim() === '' || provider.version.trim() === '') {
      throw new TypeError('derived memory view Provider identity must be non-empty')
    }
    if (!Number.isSafeInteger(provider.timeoutMs) || provider.timeoutMs < 10 || provider.timeoutMs > 5_000) {
      throw new TypeError('derived memory view timeoutMs must be an integer from 10 through 5000')
    }
    if (this.#registered.has(provider.id)) {
      throw new Error(`duplicate derived memory view Provider ${JSON.stringify(provider.id)}`)
    }
    const registered = { provider }
    this.#registered.set(provider.id, registered)
    return () => {
      if (this.#registered.get(provider.id) === registered) this.#registered.delete(provider.id)
    }
  }

  async invalidate(
    memoryIds: readonly string[],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly DerivedMemoryViewInvalidationReceiptV1[]> {
    const ids = [...new Set(memoryIds)]
    if (ids.some(id => id.trim() === '')) throw new TypeError('derived memory view IDs must be non-empty')
    if (ids.length === 0) return []
    return Promise.all([...this.#registered.values()].map(async ({ provider }) => {
      const request: DerivedMemoryViewInvalidationRequestV1 = { schemaVersion: 1, memoryIds: [...ids] }
      const controller = new AbortController()
      const forwardAbort = (): void => controller.abort(signal.reason)
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', forwardAbort, { once: true })
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            const error = new Error(`derived memory view invalidation timed out after ${provider.timeoutMs}ms`)
            controller.abort(error)
            reject(error)
          }, provider.timeoutMs)
          timer.unref?.()
        })
        await Promise.race([Promise.resolve(provider.invalidate(request, controller.signal)), timeout])
        return {
          providerId: provider.id,
          providerVersion: provider.version,
          status: 'current' as const,
        }
      } catch {
        return {
          providerId: provider.id,
          providerVersion: provider.version,
          status: 'stale' as const,
          reason: (timedOut ? 'timed-out' : 'failed') as 'timed-out' | 'failed',
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', forwardAbort)
      }
    }))
  }
}
