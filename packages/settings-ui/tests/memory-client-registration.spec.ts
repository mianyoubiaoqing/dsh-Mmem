import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'

describe('dsh-Mmem browser slot registration', () => {
  it('adds a Memory action and overlay through rc.8 public additive slots', () => {
    const injections: string[] = []
    const registrations: Array<{ entry: { name: string; id: string }; component: unknown }> = []
    const ctx = {
      effect: vi.fn(),
      get: vi.fn(() => ({ rpc: { call: vi.fn() } })),
      locale: {
        register: vi.fn(() => () => {}),
        bind: vi.fn(() => (key: string) => key),
      },
      slots: {
        inject(name: string, register: () => unknown) {
          injections.push(name)
          register()
        },
        register(entry: { name: string; id: string }, component: unknown) {
          registrations.push({ entry, component })
          return () => {}
        },
      },
    }

    apply(ctx as never)

    expect(injections).toEqual([
      'settings.plugins.tab',
      'sidebar.footer.action',
      'shell.overlay',
    ])
    expect(registrations.map(registration => registration.entry.id)).toEqual([
      'dsh-mmem',
      'dsh-mmem-explorer-trigger',
      'dsh-mmem-explorer-overlay',
    ])
  })
})
