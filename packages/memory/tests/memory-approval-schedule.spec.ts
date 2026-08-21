import { describe, expect, it } from 'vitest'
import { calculateMemoryApprovalScheduleV1 } from '../src/approval-schedule.js'

describe('Memory approval schedule', () => {
  it('keeps the scheduler disabled for the default manual policy', () => {
    expect(calculateMemoryApprovalScheduleV1({
      schemaVersion: 1,
      revision: 0,
      mode: 'manual',
    }, new Date('2026-08-21T00:00:00.000Z'))).toEqual({
      schemaVersion: 1,
      kind: 'disabled',
      policyRevision: 0,
    })
  })

  it('identifies the latest and next local daily slots before today\'s review time', () => {
    expect(calculateMemoryApprovalScheduleV1({
      schemaVersion: 1,
      revision: 4,
      mode: 'scheduled-auto',
      timeZone: 'Asia/Shanghai',
      localTime: '03:30',
    }, new Date('2026-08-20T18:00:00.000Z'))).toEqual({
      schemaVersion: 1,
      kind: 'scheduled',
      policyRevision: 4,
      timeZone: 'Asia/Shanghai',
      localTime: '03:30',
      latestDue: {
        localDate: '2026-08-20',
        dueAt: '2026-08-19T19:30:00.000Z',
      },
      nextDue: {
        localDate: '2026-08-21',
        dueAt: '2026-08-20T19:30:00.000Z',
      },
    })
  })

  it('uses today as the latest slot at or after the configured local time', () => {
    expect(calculateMemoryApprovalScheduleV1({
      schemaVersion: 1,
      revision: 4,
      mode: 'scheduled-auto',
      timeZone: 'Asia/Shanghai',
      localTime: '03:30',
    }, new Date('2026-08-20T19:30:00.000Z'))).toMatchObject({
      latestDue: {
        localDate: '2026-08-21',
        dueAt: '2026-08-20T19:30:00.000Z',
      },
      nextDue: {
        localDate: '2026-08-22',
        dueAt: '2026-08-21T19:30:00.000Z',
      },
    })
  })

  it('runs at the first valid instant after a daylight-saving gap', () => {
    expect(calculateMemoryApprovalScheduleV1({
      schemaVersion: 1,
      revision: 2,
      mode: 'scheduled-auto',
      timeZone: 'America/New_York',
      localTime: '02:30',
    }, new Date('2026-03-08T07:00:00.000Z'))).toMatchObject({
      latestDue: {
        localDate: '2026-03-08',
        dueAt: '2026-03-08T07:00:00.000Z',
      },
      nextDue: {
        localDate: '2026-03-09',
        dueAt: '2026-03-09T06:30:00.000Z',
      },
    })
  })

  it('uses the first occurrence of an ambiguous daylight-saving time', () => {
    expect(calculateMemoryApprovalScheduleV1({
      schemaVersion: 1,
      revision: 2,
      mode: 'scheduled-auto',
      timeZone: 'America/New_York',
      localTime: '01:30',
    }, new Date('2026-11-01T05:30:00.000Z'))).toMatchObject({
      latestDue: {
        localDate: '2026-11-01',
        dueAt: '2026-11-01T05:30:00.000Z',
      },
      nextDue: {
        localDate: '2026-11-02',
        dueAt: '2026-11-02T06:30:00.000Z',
      },
    })
  })
})
