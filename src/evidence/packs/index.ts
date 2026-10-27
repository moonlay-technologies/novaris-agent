import { AnyEvidencePack } from '../evidencePack';
import { AccessPack } from './accessPack';
import { AuditPack } from './auditPack';
import { EncryptionPack } from './encryptionPack';
import { ExposurePack } from './exposurePack';
import { HardeningPack } from './hardeningPack';
import { IdentityPack } from './identityPack';
import { PatchPack } from './patchPack';
import { ProtectionPack } from './protectionPack';
import { SoftwarePack, SoftwareSnapshot } from './softwarePack';

export interface EvidencePackDependencies {
  software: () => SoftwareSnapshot;
}

/** Category packs in catalog order. The agent pack is added by EvidenceCollector itself. */
export function createEvidencePacks(dependencies: EvidencePackDependencies): AnyEvidencePack[] {
  return [
    new IdentityPack(),
    new PatchPack(),
    new ProtectionPack(),
    new EncryptionPack(),
    new AccessPack(),
    new ExposurePack(),
    new SoftwarePack(dependencies.software),
    new HardeningPack(),
    new AuditPack(),
  ];
}
