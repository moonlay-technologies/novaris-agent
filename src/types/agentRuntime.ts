/**
 * Mirrors `novaris-backend/src/types/hermesBootstrap.ts`. Kept in sync
 * manually — no shared package exists between the two repos yet.
 *
 * This is the contract returned by `POST /api/v1/hermes-installs/bootstrap`,
 * used by the Electron app to configure and lock down the embedded Hermes
 * runtime. It never contains a raw AI provider key — all AI traffic flows
 * through the backend's shared proxy at `proxyEndpointUrl`.
 */

export interface HermesDeviceBinding {
  deviceId: number;
  userId: number | null;
  clientId: number;
  branchId: number | null;
}

export interface HermesReleaseMetadata {
  id: number;
  version: string;
  osType: string;
  arch: string | null;
  artifactType: string | null;
  downloadUrl: string;
}

export interface HermesBootstrapPayload {
  installId: number;
  deviceBinding: HermesDeviceBinding;
  backendBaseUrl: string;
  proxyEndpointUrl: string;
  policyVersion: string;
  allowedTools: string[];
  workspacePathRule: string;
  releaseMetadata: HermesReleaseMetadata;
  installToken: string | null;
  existingHermesDetected: boolean;
}
