/**
 * Addresses a model-driven fetch must never reach.
 *
 * The rules moved to `@meridian/shared` once a fourth part of the product
 * needed the same answer — an agent's fetch tool, the browser engine, the
 * discovery engine, and the route that lets an operator repoint a provider.
 * Four copies is three chances to fix one and miss the others, and the copies
 * had already drifted: this one did not recognise `http://2130706433/` as
 * 127.0.0.1.
 *
 * Re-exported under the old name because this is the import every call site in
 * this package already uses.
 */
export { isPrivateHost } from '@meridian/shared';
