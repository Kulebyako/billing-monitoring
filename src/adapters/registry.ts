import type { ProviderAdapter } from './types.js';
import { landvpsAdapter } from './landvps.js';
import { vpsvilleAdapter } from './vpsville.js';
import { hsvdsAdapter } from './hsvds.js';
import { play2goAdapter } from './play2go.js';
import { yun62Adapter } from './yun62.js';
import { kyonixAdapter } from './kyonix.js';

const adapters: ProviderAdapter[] = [
  landvpsAdapter,
  vpsvilleAdapter,
  hsvdsAdapter,
  play2goAdapter,
  yun62Adapter,
  kyonixAdapter,
];

const byId = new Map(adapters.map((a) => [a.id, a]));

export function getAdapter(providerId: string): ProviderAdapter | undefined {
  return byId.get(providerId);
}

export function listAdapters(): Array<{ id: string; label: string }> {
  return adapters.map((a) => ({ id: a.id, label: a.label }));
}
