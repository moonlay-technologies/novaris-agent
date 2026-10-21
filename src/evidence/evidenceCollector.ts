import { AnyEvidencePack, EvidenceContext } from './evidencePack';
import { EvidenceHealthTracker } from './evidenceHealthTracker';
import { AgentHealthPack } from './packs/agentHealthPack';
import {
  CollectedCategoryId,
  EvidenceCategoryPayload,
  EvidenceEnvelope,
  EvidenceItem,
  ImplementedCategoryId,
} from '../types/evidence';
import { getLogger } from '../utils/logger';

/**
 * Runs the category packs and assembles the evidence envelope. One failing pack
 * never stops the others: its category is left out, so the server sees missing
 * (UNKNOWN) evidence for it rather than a fabricated result.
 */
export class EvidenceCollector {
  private readonly logger = getLogger();
  private readonly agentPack: AgentHealthPack;

  constructor(
    private readonly packs: AnyEvidencePack[],
    private readonly tracker: EvidenceHealthTracker,
    configHash: () => string | null,
    private readonly agentVersion: string,
  ) {
    this.agentPack = new AgentHealthPack(tracker, configHash);
  }

  async collect(context: EvidenceContext): Promise<EvidenceEnvelope> {
    const categories: EvidenceCategoryPayload[] = [];

    for (const pack of this.packs) {
      const payload = await this.runPack(pack, context);
      if (payload) categories.push(payload);
    }

    // Last, so its collector list reflects this run
    const agent = await this.runPack(this.agentPack, context);
    if (agent) categories.push(agent);

    return {
      schema_version: 1,
      agent_version: this.agentVersion,
      platform: context.platform,
      run_mode: context.runMode,
      elevated: context.elevated,
      sent_at: context.now().toISOString(),
      categories,
    };
  }

  private async runPack(pack: AnyEvidencePack, context: EvidenceContext): Promise<EvidenceCategoryPayload | null> {
    const collectedAt = context.now();
    try {
      const items = await pack.collect(context);
      this.track(pack.category, collectedAt, Object.values(items) as Array<EvidenceItem<unknown> | undefined>);
      return { category: pack.category, collected_at: collectedAt.toISOString(), items } as EvidenceCategoryPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Evidence pack failed', { category: pack.category, error: message });
      if (pack.category !== 'agent') this.tracker.recordError(pack.category, collectedAt, message);
      return null;
    }
  }

  private track(category: ImplementedCategoryId, at: Date, items: Array<EvidenceItem<unknown> | undefined>): void {
    if (category === 'agent') return;
    const collected = category as CollectedCategoryId;
    const firstError = items.find((item) => item?.status === 'error');
    if (firstError) {
      this.tracker.recordError(collected, at, firstError.error || `${firstError.source}: ${firstError.reason}`);
    } else {
      this.tracker.recordSuccess(collected, at);
    }
  }
}
