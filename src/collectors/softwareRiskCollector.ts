import { InstalledSoftware } from '../types/device';

export interface SoftwareRiskFinding {
  softwareName: string;
  version: string | null;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface SoftwareRiskAssessment {
  checkedAt: Date;
  hackedIndicators: SoftwareRiskFinding[];
  missingLicenseIndicators: SoftwareRiskFinding[];
}

const HACKED_KEYWORDS: string[] = [
  'crack',
  'keygen',
  'activator',
  'kmspico',
  'loader',
  'patcher',
  'x-force',
  'genp',
  'repack',
  'license bypass',
];

const LICENSABLE_SOFTWARE_KEYWORDS: string[] = [
  'adobe',
  'autodesk',
  'solidworks',
  'microsoft office',
  'visio',
  'project',
  'jetbrains',
  'vmware workstation',
  'matlab',
  'coreldraw',
];

const LICENSE_SIGNAL_KEYWORDS: string[] = [
  'creative cloud',
  'autodesk access',
  'microsoft 365',
  'office 365',
  'jetbrains toolbox',
  'solidworks licensing',
  'network license manager',
  'flexnet',
];

export class SoftwareRiskCollector {
  collect(softwareList: InstalledSoftware[]): SoftwareRiskAssessment {
    const checkedAt = new Date();
    const hackedIndicators = this.detectHackedIndicators(softwareList);
    const missingLicenseIndicators = this.detectMissingLicenseIndicators(softwareList);

    return {
      checkedAt,
      hackedIndicators,
      missingLicenseIndicators,
    };
  }

  summarize(assessment: SoftwareRiskAssessment, maxItemsPerCategory: number = 10): string {
    const hackedSample = assessment.hackedIndicators.slice(0, maxItemsPerCategory);
    const missingLicenseSample = assessment.missingLicenseIndicators.slice(0, maxItemsPerCategory);

    const hackedLines = hackedSample.length
      ? hackedSample.map((item) => `- ${item.softwareName}: ${item.reason} [${item.confidence}]`).join('\n')
      : '- (none)';

    const missingLicenseLines = missingLicenseSample.length
      ? missingLicenseSample.map((item) => `- ${item.softwareName}: ${item.reason} [${item.confidence}]`).join('\n')
      : '- (none)';

    return [
      'software_risk_assessment=heuristic',
      `checked_at=${assessment.checkedAt.toISOString()}`,
      `hacked_indicators_count=${assessment.hackedIndicators.length}`,
      `missing_license_indicators_count=${assessment.missingLicenseIndicators.length}`,
      'hacked_indicators_sample:',
      hackedLines,
      'missing_license_indicators_sample:',
      missingLicenseLines,
    ].join('\n');
  }

  private detectHackedIndicators(softwareList: InstalledSoftware[]): SoftwareRiskFinding[] {
    const findings: SoftwareRiskFinding[] = [];

    for (const software of softwareList) {
      const normalizedName = software.name.toLowerCase();
      const normalizedVersion = (software.version || '').toLowerCase();

      const keyword = HACKED_KEYWORDS.find((term) =>
        normalizedName.includes(term) || normalizedVersion.includes(term)
      );

      if (!keyword) {
        continue;
      }

      findings.push({
        softwareName: software.name,
        version: software.version,
        reason: `Keyword '${keyword}' found in software inventory`,
        confidence: keyword === 'kmspico' || keyword === 'keygen' || keyword === 'crack' ? 'high' : 'medium',
      });
    }

    return findings;
  }

  private detectMissingLicenseIndicators(softwareList: InstalledSoftware[]): SoftwareRiskFinding[] {
    const findings: SoftwareRiskFinding[] = [];
    const normalizedNames = softwareList.map((software) => software.name.toLowerCase());

    const hasLicenseSignal = normalizedNames.some((name) =>
      LICENSE_SIGNAL_KEYWORDS.some((signal) => name.includes(signal))
    );

    for (const software of softwareList) {
      const normalizedName = software.name.toLowerCase();
      const normalizedVersion = (software.version || '').toLowerCase();

      if (normalizedVersion.includes('trial') || normalizedName.includes('trial')) {
        findings.push({
          softwareName: software.name,
          version: software.version,
          reason: "Trial edition detected; license entitlement may be missing or expired",
          confidence: 'medium',
        });
        continue;
      }

      const licensableKeyword = LICENSABLE_SOFTWARE_KEYWORDS.find((keyword) => normalizedName.includes(keyword));
      if (!licensableKeyword) {
        continue;
      }

      if (!hasLicenseSignal) {
        findings.push({
          softwareName: software.name,
          version: software.version,
          reason: `Potentially licensable software '${licensableKeyword}' found without local license management signal`,
          confidence: 'low',
        });
      }
    }

    return findings;
  }
}