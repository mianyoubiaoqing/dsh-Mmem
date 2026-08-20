import type { MemoryApprovalPolicyV1 } from './approval-policy.js'

/** One daily scheduled-auto slot identified independently of its UTC offset. */
export interface MemoryApprovalScheduleSlotV1 {
  localDate: string
  dueAt: string
}

/** Current scheduler view derived from one immutable policy revision. */
export type MemoryApprovalScheduleV1 = {
  schemaVersion: 1
  kind: 'disabled'
  policyRevision: number
} | {
  schemaVersion: 1
  kind: 'scheduled'
  policyRevision: number
  timeZone: string
  localTime: string
  latestDue: MemoryApprovalScheduleSlotV1
  nextDue: MemoryApprovalScheduleSlotV1
}

interface LocalClockV1 {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const MINUTE_MS = 60_000
const SEARCH_RADIUS_MINUTES = 18 * 60
const SLOT_SEARCH_DAYS = 8

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function localClock(formatter: Intl.DateTimeFormat, instant: Date): LocalClockV1 {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const part of formatter.formatToParts(instant)) values[part.type] = part.value
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

function localDate(clock: Pick<LocalClockV1, 'year' | 'month' | 'day'>): string {
  return `${String(clock.year).padStart(4, '0')}-${String(clock.month).padStart(2, '0')}`
    + `-${String(clock.day).padStart(2, '0')}`
}

function shiftLocalDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10)
}

function slotForLocalDate(
  date: string,
  localTime: string,
  formatter: Intl.DateTimeFormat,
): MemoryApprovalScheduleSlotV1 | undefined {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const [hour, minute] = localTime.split(':').map(Number) as [number, number]
  const targetClock = hour * 60 + minute
  const approximate = Date.UTC(year, month - 1, day, hour, minute)
  let firstAfterGap: { clock: number; instant: number } | undefined

  for (let offset = -SEARCH_RADIUS_MINUTES; offset <= SEARCH_RADIUS_MINUTES; offset += 1) {
    const instant = approximate + offset * MINUTE_MS
    const clock = localClock(formatter, new Date(instant))
    if (localDate(clock) !== date) continue
    const clockMinute = clock.hour * 60 + clock.minute
    if (clockMinute === targetClock) return { localDate: date, dueAt: new Date(instant).toISOString() }
    if (clockMinute > targetClock
      && (firstAfterGap === undefined
        || clockMinute < firstAfterGap.clock
        || (clockMinute === firstAfterGap.clock && instant < firstAfterGap.instant))) {
      firstAfterGap = { clock: clockMinute, instant }
    }
  }

  return firstAfterGap === undefined
    ? undefined
    : { localDate: date, dueAt: new Date(firstAfterGap.instant).toISOString() }
}

function nearestSlot(
  today: string,
  direction: -1 | 1,
  predicate: (instant: number) => boolean,
  localTime: string,
  formatter: Intl.DateTimeFormat,
): MemoryApprovalScheduleSlotV1 {
  for (let distance = 0; distance <= SLOT_SEARCH_DAYS; distance += 1) {
    const slot = slotForLocalDate(shiftLocalDate(today, distance * direction), localTime, formatter)
    if (slot !== undefined && predicate(Date.parse(slot.dueAt))) return slot
  }
  throw new Error('memory approval schedule has no valid daily slot within eight local days')
}

/**
 * Calculate the latest due slot and the next slot without starting timers or reading runtime state.
 * Missing DST clock times run at the first valid instant after the gap; ambiguous times use their first occurrence.
 */
export function calculateMemoryApprovalScheduleV1(
  policy: MemoryApprovalPolicyV1,
  now: Date,
): MemoryApprovalScheduleV1 {
  if (policy.mode === 'manual') {
    return { schemaVersion: 1, kind: 'disabled', policyRevision: policy.revision }
  }
  if (!Number.isFinite(now.getTime())) throw new Error('memory approval schedule now must be a valid Date')
  const formatter = zonedFormatter(policy.timeZone)
  const nowTime = now.getTime()
  const today = localDate(localClock(formatter, now))
  return {
    schemaVersion: 1,
    kind: 'scheduled',
    policyRevision: policy.revision,
    timeZone: policy.timeZone,
    localTime: policy.localTime,
    latestDue: nearestSlot(today, -1, instant => instant <= nowTime, policy.localTime, formatter),
    nextDue: nearestSlot(today, 1, instant => instant > nowTime, policy.localTime, formatter),
  }
}
