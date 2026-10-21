import { CollectedCategoryId, CollectorHealth } from '../types/evidence';

/** Remembers, per category, when collection last succeeded and the most recent error. */
export class EvidenceHealthTracker {
  private readonly state = new Map<CollectedCategoryId, CollectorHealth>();

  recordSuccess(category: CollectedCategoryId, at: Date): void {
    const entry = this.entry(category);
    entry.last_success_at = at.toISOString();
  }

  recordError(category: CollectedCategoryId, at: Date, message: string): void {
    const entry = this.entry(category);
    entry.last_error_at = at.toISOString();
    entry.last_error = message.slice(0, 255);
  }

  snapshot(): CollectorHealth[] {
    return Array.from(this.state.values()).map((entry) => ({ ...entry }));
  }

  private entry(category: CollectedCategoryId): CollectorHealth {
    let entry = this.state.get(category);
    if (!entry) {
      entry = { category, last_success_at: null, last_error_at: null, last_error: null };
      this.state.set(category, entry);
    }
    return entry;
  }
}
