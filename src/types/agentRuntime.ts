/**
 * Mirrors the response of `GET /api/v1/me/assistant` in novaris-backend
 * (built by `HermesPolicyService`). Kept in sync manually; no shared package
 * exists between the two repos yet.
 *
 * Used by the Electron app to configure and lock down the local agent runtime
 * (LangChain Deep Agents). It never contains a raw AI provider key: all AI
 * traffic flows through the backend's proxy at `proxyEndpointUrl`, signed in
 * as the device's Novaris user.
 */

export type AgentRuntimeKind = 'deepagents';

export interface AssistantPolicyPayload {
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
}
