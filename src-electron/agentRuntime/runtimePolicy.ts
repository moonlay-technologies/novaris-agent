import * as path from 'path';
import { AssistantPolicyPayload } from '../../dist/types/agentRuntime';

/**
 * The validated policy the local runtime is started with. The user's JWT is
 * deliberately not part of it; the supervisor passes it separately.
 */
export interface LockedAgentPolicy {
  backendBaseUrl: string;
  proxyEndpointUrl: string;
  webSearchEndpointUrl: string | null;
  policyVersion: string;
  allowedTools: string[];
  workspacePath: string;
  model: string;
  maxInputTokens: number;
  systemPrompt: string;
}

/** Builds and validates the local policy used by the managed agent runtime. */
export class AgentRuntimePolicy {
  static fromPayload(payload: AssistantPolicyPayload): LockedAgentPolicy {
    if (payload.runtime !== 'deepagents') {
      throw new Error(`This app version cannot run the "${payload.runtime}" agent runtime`);
    }

    const backendUrl = new URL(payload.backendBaseUrl);
    if (backendUrl.protocol !== 'https:' && backendUrl.hostname !== 'localhost' && backendUrl.hostname !== '127.0.0.1') {
      throw new Error('Agent backend URL must use HTTPS outside local development');
    }

    // The backend sends these as paths relative to its own base URL.
    const proxyUrl = AgentRuntimePolicy.sameOriginUrl(payload.proxyEndpointUrl, backendUrl, 'proxy endpoint');
    const webSearchUrl = payload.webSearchEndpointUrl
      ? AgentRuntimePolicy.sameOriginUrl(payload.webSearchEndpointUrl, backendUrl, 'web search endpoint')
      : null;

    if (!payload.policyVersion || payload.allowedTools.some((tool) => !/^[a-z0-9_-]+$/i.test(tool))) {
      throw new Error('The assistant policy from the backend is invalid');
    }
    if (!/^[\w.:/-]{1,100}$/.test(payload.model)) {
      throw new Error('The assistant policy from the backend has an invalid model name');
    }

    return {
      backendBaseUrl: backendUrl.toString().replace(/\/$/, ''),
      proxyEndpointUrl: proxyUrl,
      webSearchEndpointUrl: webSearchUrl,
      policyVersion: payload.policyVersion,
      allowedTools: [...payload.allowedTools],
      workspacePath: AgentRuntimePolicy.resolveWorkspacePath(payload.workspacePathRule),
      model: payload.model,
      maxInputTokens: payload.maxInputTokens,
      systemPrompt: payload.systemPrompt,
    };
  }

  private static sameOriginUrl(value: string, backendUrl: URL, label: string): string {
    const resolved = new URL(value, backendUrl);
    if (resolved.origin !== backendUrl.origin) {
      throw new Error(`Agent ${label} must belong to the configured Novaris backend`);
    }
    return resolved.toString();
  }

  private static resolveWorkspacePath(rule: string): string {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    // `[Documents]/AssetAssistant` style rules name a folder under the user's profile.
    const normalizedRule = (rule || '').trim().replace(/^\[Documents\]/i, 'Documents');

    if (!normalizedRule || normalizedRule === ':workspace') {
      return path.join(home, 'AssetAssistant');
    }

    const resolved = path.isAbsolute(normalizedRule)
      ? path.resolve(normalizedRule)
      : path.resolve(home, normalizedRule.replace(/^[:/\\]+/, ''));
    const homeResolved = path.resolve(home);
    if (resolved !== homeResolved && !resolved.startsWith(`${homeResolved}${path.sep}`)) {
      throw new Error('Agent workspace must be inside the current user profile');
    }
    return resolved;
  }
}
