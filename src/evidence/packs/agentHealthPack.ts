import { EvidenceContext, EvidencePack } from '../evidencePack';
import { EvidenceHealthTracker } from '../evidenceHealthTracker';
import { ok } from '../evidenceItem';
import { AgentItems } from '../../types/evidence';

/** Reports whether the agent itself can produce complete, current evidence. Runs after the other packs. */
export class AgentHealthPack implements EvidencePack<'agent'> {
  readonly category = 'agent' as const;

  constructor(
    private readonly tracker: EvidenceHealthTracker,
    private readonly configHash: () => string | null,
  ) {}

  async collect(context: EvidenceContext): Promise<AgentItems> {
    const available = context.osquery.available();
    return {
      health: ok('agent:internal', {
        run_mode: context.runMode,
        elevated: context.elevated,
        osquery_available: available,
        osquery_version: available ? await context.osquery.version() : null,
        config_hash: this.configHash(),
        collectors: this.tracker.snapshot(),
      }),
    };
  }
}
