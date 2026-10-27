import { createHash } from 'crypto';
import { EvidenceContext, EvidencePack } from '../evidencePack';
import { ok, unknown } from '../evidenceItem';
import { InstalledSoftware } from '../../types/device';
import { SoftwareItems } from '../../types/evidence';

/** The agent's latest software collection, as kept for /software/sync. */
export interface SoftwareSnapshot {
  enabled: boolean;
  /** null = not collected yet in this run. */
  items: InstalledSoftware[] | null;
  lastSyncedAt: Date | null;
}

export function inventoryHash(items: InstalledSoftware[]): string {
  const lines = items.map((item) => `${item.name.trim().toLowerCase()}|${(item.version || '').trim().toLowerCase()}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Software Inventory summary. The list itself keeps travelling through
 * /software/sync (used by software policies); this reports its size,
 * fingerprint and freshness, so an empty or stale inventory is visible.
 */
export class SoftwarePack implements EvidencePack<'software'> {
  readonly category = 'software' as const;

  constructor(private readonly snapshot: () => SoftwareSnapshot) {}

  async collect(context: EvidenceContext): Promise<SoftwareItems> {
    const source = 'agent:software-inventory';
    const snapshot = this.snapshot();
    if (!snapshot.enabled) return { inventory: unknown(source, 'not_configured', 'software collection is disabled (collectSoftware=false)') };
    if (snapshot.items === null) return { inventory: unknown(source, 'not_detected', 'software inventory not collected yet') };
    // The inventory comes from osquery tables; an empty list without osquery means "could not read"
    if (snapshot.items.length === 0 && !context.osquery.available()) {
      return { inventory: unknown(source, 'tool_unavailable', 'osquery binary not bundled') };
    }
    return {
      inventory: ok(source, {
        item_count: snapshot.items.length,
        inventory_hash: inventoryHash(snapshot.items),
        last_synced_at: snapshot.lastSyncedAt ? snapshot.lastSyncedAt.toISOString() : null,
      }),
    };
  }
}
