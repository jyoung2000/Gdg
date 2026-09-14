import type { ProviderSchedule, SchedulePersistence } from '@meridian/control-sdk';
import type { Store } from '../db/store.js';

/**
 * Discovery pacing, kept in the database instead of in a Map.
 *
 * A `DiscoveryScheduler` enforces a minimum interval, exponential backoff and a
 * pause after repeated failures — all of which existed only for as long as the
 * process did. That is precisely backwards: a restart is most likely when
 * something is going wrong, and the old behaviour was to come back up having
 * forgotten every reason to be careful and query the failing provider again
 * immediately.
 *
 * `scope` keeps the two schedulers apart. Provider model discovery and the
 * free-inference dataset refresh pace different things at very different rates,
 * and a shared row would have each reading the other's backoff.
 */
export function schedulePersistence(store: Store, scope: string): SchedulePersistence {
  return {
    load: (): ProviderSchedule[] => store.loadDiscoverySchedules(scope),
    save: (schedule: ProviderSchedule): void => store.saveDiscoverySchedule(scope, schedule),
    remove: (providerId: string): void => store.deleteDiscoverySchedule(scope, providerId),
  };
}
