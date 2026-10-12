/**
 * Mirrors `novaris-backend/src/types/hermesBootstrap.ts`. Kept in sync
 * manually — no shared package exists between the two repos yet.
 *
 * This is the contract returned by `POST /api/v1/agent-installs/bootstrap`,
 * used by the Electron app to configure and lock down the local agent
 * runtime (LangChain Deep Agents). It never contains a raw AI provider key —
 * all AI traffic flows through the backend's shared proxy at `proxyEndpointUrl`.
 */

export type AgentRuntimeKind = 'deepagents' | 'hermes';

export interface AgentDeviceBinding {
  deviceId: number;
  userId: number | null;
  clientId: number;
  branchId: number | null;
}

export interface AgentReleaseMetadata {
  id: number;
  version: string;
  osType: string;
  arch: string | null;
  artifactType: string | null;
  downloadUrl: string;
}

export interface AgentBootstrapPayload {
  installId: number;
  deviceBinding: AgentDeviceBinding;
  backendBaseUrl: string;
  /** May be relative to `backendBaseUrl`. */
  proxyEndpointUrl: string;
  policyVersion: string;
  allowedTools: string[];
  workspacePathRule: string;
  runtime: AgentRuntimeKind;
  model: string;
  maxInputTokens: number;
  systemPrompt: string;
  /** May be relative to `backendBaseUrl`. */
  webSearchEndpointUrl: string | null;
  releaseMetadata: AgentReleaseMetadata;
  installToken: string | null;
}
