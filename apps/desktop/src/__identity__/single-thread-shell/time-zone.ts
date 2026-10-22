/**
 * The time zone the goldens beside this file were recorded in.
 *
 * Every fixture in render.tsx is a local wall-clock time, so anything rendered
 * as an instant (the sidebar's `<time datetime>`) moves with the machine's
 * zone: the goldens were recorded on a Mac in America/Los_Angeles and CI runs
 * in UTC. Importing this module pins the recording zone for the process before
 * any fixture or cached date formatter is built; import it FIRST, ahead of
 * every app module, and call restoreRecordingTimeZone() when the file is done
 * so the zone does not leak into other test files in the same worker.
 */

export const GOLDEN_TIME_ZONE = 'America/Los_Angeles'

const previousTimeZone = process.env.TZ

process.env.TZ = GOLDEN_TIME_ZONE

export function restoreRecordingTimeZone(): void {
  if (previousTimeZone === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = previousTimeZone
  }
}
