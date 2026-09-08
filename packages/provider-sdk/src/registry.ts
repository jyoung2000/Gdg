import type { ProviderDescriptor, SupportState } from '@meridian/shared';
import type { AdapterSurface, ProviderAdapter } from './adapter.js';

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
  /** What each adapter can execute, recorded when the provider first answered. */
  private readonly surfaces = new Map<string, AdapterSurface>();
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

  /**
   * Record that a live call to this provider succeeded, and what its adapter
   * can execute.
   *
   * Two separate facts, and they used to be conflated under one misleading
   * name. This was `setVerified(id, adapter.capabilities())`, exposed as
   * `verifiedCapabilities` — but what it stored was compile-time introspection
   * (`typeof adapter.image === 'function'`), which is a fact about which
   * methods somebody wrote, not about anything a provider did. A client reading
   * `verifiedCapabilities.image === true` was being told a live call had
   * confirmed image generation when nothing of the sort had happened.
   *
   * What IS verified by reaching here is contact: the provider answered. That
   * is what `supportState` uses it for and all it ever meant.
   */
  recordLiveContact(providerId: string, surface: AdapterSurface): void {
    this.surfaces.set(providerId, surface);
    this.verifiedAtMs.set(providerId, Date.now());
  }

  /**
   * Which methods this provider's adapter implements.
   *
   * A ceiling on what Meridian could even attempt, never evidence about what
   * the provider can do. Capability evidence lives on the model, in
   * `capabilityClaims`, and is earned by a probe.
   */
  adapterSurface(providerId: string): AdapterSurface | null {
    return this.surfaces.get(providerId) ?? null;
  }

  /** Has any call to this provider succeeded in this process? */
  hasLiveContact(providerId: string): boolean {
    return this.surfaces.has(providerId);
  }

  /**
   * How the UI is allowed to describe this provider.
   *
   * `supported`   adapter exists, a credential is available, and this process
   *               has seen a call to the provider succeed. It says nothing
   *               about which capabilities work — that is per-model evidence,
   *               earned by a probe and recorded in `capabilityClaims`.
   * `experimental` adapter and credential exist, but no call has succeeded yet.
   * `not_configured` adapter exists but no credential is available.
   * `unavailable` no adapter — the provider cannot be used at all.
   */
  supportState(providerId: string): SupportState {
    const descriptor = this.descriptors.get(providerId);
    if (!descriptor || !this.factories.has(descriptor.adapter)) return 'unavailable';
    if (this.disabled.has(providerId)) return 'disabled';
    if (!this.isCredentialed(providerId)) return 'not_configured';
    return this.surfaces.has(providerId) ? 'supported' : 'experimental';
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
