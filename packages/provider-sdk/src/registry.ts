import type { ProviderDescriptor, SupportState } from '@meridian/shared';
import type { AdapterCapabilities, ProviderAdapter } from './adapter.js';

export type AdapterFactory = (descriptor: ProviderDescriptor) => ProviderAdapter;

/**
 * The provider registry.
 *
 * Registration is the mechanism behind the "no fake support" rule: a provider
 * descriptor without a registered adapter factory can be listed in the catalog
 * and shown in the UI, but {@link ProviderRegistry.supportState} will report it
 * as `unavailable` and the router will never select it.
 */
export class ProviderRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly descriptors = new Map<string, ProviderDescriptor>();
  private readonly instances = new Map<string, ProviderAdapter>();
  /** Provider ids for which at least one usable credential has been resolved. */
  private readonly credentialed = new Set<string>();
  /** Capabilities confirmed against the live API, keyed by provider id. */
  private readonly verified = new Map<string, AdapterCapabilities>();
  private readonly verifiedAtMs = new Map<string, number>();
  private readonly disabled = new Set<string>();

  /** Register an adapter implementation under an `adapter` key. */
  registerAdapter(key: string, factory: AdapterFactory): void {
    this.factories.set(key, factory);
  }

  /** Add or replace a provider descriptor. */
  registerProvider(descriptor: ProviderDescriptor): void {
    this.descriptors.set(descriptor.id, descriptor);
    this.instances.delete(descriptor.id);
  }

  hasAdapter(descriptor: ProviderDescriptor): boolean {
    return this.factories.has(descriptor.adapter);
  }

  get(providerId: string): ProviderAdapter | null {
    const cached = this.instances.get(providerId);
    if (cached) return cached;
    const descriptor = this.descriptors.get(providerId);
    if (!descriptor) return null;
    const factory = this.factories.get(descriptor.adapter);
    if (!factory) return null;
    const instance = factory(descriptor);
    this.instances.set(providerId, instance);
    return instance;
  }

  descriptor(providerId: string): ProviderDescriptor | null {
    return this.descriptors.get(providerId) ?? null;
  }

  descriptors_(): ProviderDescriptor[] {
    return [...this.descriptors.values()];
  }

  list(): ProviderDescriptor[] {
    return [...this.descriptors.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Operator kill-switch. A disabled provider stays registered — its models,
   * credential state and history remain inspectable — but routing must never
   * select it. Deleting it instead would forget everything the operator knows
   * about it just to express "not right now".
   */
  setEnabled(providerId: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(providerId);
    else this.disabled.add(providerId);
  }

  isEnabled(providerId: string): boolean {
    return !this.disabled.has(providerId);
  }

  /** When a live call last confirmed this provider, across restarts. */
  setVerifiedAt(providerId: string, at: number): void {
    this.verifiedAtMs.set(providerId, at);
  }

  /**
   * The recorded time of the last live verification, or null. Deliberately a
   * timestamp and not a capability upgrade: a date proves it was verified once,
   * not that today's API still behaves the same, so supportState stays
   * `experimental` until this process has seen a live call succeed.
   */
  verifiedAt(providerId: string): number | null {
    return this.verifiedAtMs.get(providerId) ?? null;
  }

  /** Record that a provider has a usable credential (or needs none). */
  setCredentialed(providerId: string, has: boolean): void {
    if (has) this.credentialed.add(providerId);
    else this.credentialed.delete(providerId);
  }

  isCredentialed(providerId: string): boolean {
    const d = this.descriptors.get(providerId);
    if (d && d.auth === 'none') return true;
    return this.credentialed.has(providerId);
  }

  /** Record capabilities confirmed by a successful live call. */
  setVerified(providerId: string, caps: AdapterCapabilities): void {
    this.verified.set(providerId, caps);
    this.verifiedAtMs.set(providerId, Date.now());
  }

  verifiedCapabilities(providerId: string): AdapterCapabilities | null {
    return this.verified.get(providerId) ?? null;
  }

  /**
   * How the UI is allowed to describe this provider.
   *
   * `supported`   adapter exists, a credential is available, and capabilities
   *               were confirmed against the live API.
   * `experimental` adapter and credential exist, but nothing has been verified yet.
   * `not_configured` adapter exists but no credential is available.
   * `unavailable` no adapter — the provider cannot be used at all.
   */
  supportState(providerId: string): SupportState {
    const descriptor = this.descriptors.get(providerId);
    if (!descriptor || !this.factories.has(descriptor.adapter)) return 'unavailable';
    if (this.disabled.has(providerId)) return 'disabled';
    if (!this.isCredentialed(providerId)) return 'not_configured';
    return this.verified.has(providerId) ? 'supported' : 'experimental';
  }

  /** Providers that can actually serve traffic right now. */
  usable(): ProviderDescriptor[] {
    return this.list().filter((d) => {
      const state = this.supportState(d.id);
      return state === 'supported' || state === 'experimental';
    });
  }

  clearInstances(): void {
    this.instances.clear();
  }
}
