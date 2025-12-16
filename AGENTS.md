# Development Instructions for Novaris Agent

This document provides development guidelines and conventions for the Novaris Agent project. Follow these instructions when working on this codebase.

## Tech Stack

### Core Framework
- **Node.js** agent application
- **TypeScript** for type safety
- Follow **SOLID principles** in all code design
- **systeminformation** library for device data collection
- **Axios** for HTTP requests to backend API
- **Winston** for structured logging

## Architecture Principles

### SOLID Principles

#### Single Responsibility Principle (SRP)
- Each class/module should have one reason to change
- Separate concerns: collectors, services, types, utils
- Collectors handle data collection only
- Services handle business logic and API communication

#### Open/Closed Principle (OCP)
- Open for extension, closed for modification
- Use interfaces and abstractions
- Prefer composition over inheritance

#### Liskov Substitution Principle (LSP)
- Derived classes must be substitutable for their base classes
- Interfaces should be properly implemented

#### Interface Segregation Principle (ISP)
- Clients should not depend on interfaces they don't use
- Create specific interfaces rather than large general ones

#### Dependency Inversion Principle (DIP)
- Depend on abstractions, not concretions
- High-level modules should not depend on low-level modules
- Both should depend on abstractions

## Project Structure

```
src/
├── collectors/     # Data collection modules (device info, health metrics, software)
├── services/      # Business logic (agent service, reporting service)
├── types/         # TypeScript type definitions
├── utils/         # Utility functions (config, logger)
└── index.ts       # Application entry point
```

## Code Organization

### Collector Layer
- Handles data collection from the system
- Uses `systeminformation` library for system data
- Returns typed data structures
- No business logic, only data gathering
- Should handle errors gracefully and log warnings

```typescript
export class DeviceInfoCollector {
  private logger = getLogger();

  async collect(): Promise<DeviceInfo> {
    try {
      // Collect device information
      const hostname = os.hostname();
      // ... more collection logic
      return deviceInfo;
    } catch (error) {
      this.logger.error('Failed to collect device info', { error });
      throw error;
    }
  }
}
```

### Service Layer
- Contains business logic
- Handles API communication
- Manages retry logic and error handling
- Orchestrates collectors
- Handles offline queue management

```typescript
export class ReportingService {
  private apiClient: AxiosInstance;
  private reportQueue: DeviceReport[] = [];

  async reportHealth(deviceId: number, report: DeviceReport): Promise<void> {
    try {
      await this.apiClient.post(`/devices/${deviceId}/health`, report);
      this.logger.info('Health report sent successfully');
    } catch (error) {
      this.logger.error('Failed to report health', { error });
      // Queue for retry
      this.reportQueue.push(report);
      throw error;
    }
  }
}
```

### Agent Service
- Main orchestrator for the agent
- Manages collection and reporting intervals
- Handles device registration
- Coordinates between collectors and reporting service
- Manages graceful shutdown

## Error Handling

### Error Types
- Create specific error classes for different error scenarios
- Handle network errors gracefully with retry logic
- Log errors appropriately with context
- Never crash the agent on non-critical errors

```typescript
export class NetworkError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class CollectionError extends Error {
  constructor(message: string, public collector: string) {
    super(message);
    this.name = 'CollectionError';
  }
}
```

### Retry Logic
- Always implement retry logic for network operations
- Use exponential backoff for retries
- Respect `retryAttempts` and `retryDelay` from config
- Queue failed reports for later processing

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  delay: number
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (attempt + 1)));
      }
    }
  }
  
  throw lastError;
}
```

## Logging

- Use Winston for structured logging
- Log important events (device registration, health reports, errors)
- Include context in log messages (device ID, asset tag, etc.)
- Use appropriate log levels (debug, info, warn, error)
- Log to both console and file

```typescript
import { createLogger } from './utils/logger';

const logger = createLogger(config);

logger.info('Device registered', { deviceId: 123, assetTag: 'ASSET-001' });
logger.error('Failed to report health', { error, deviceId: 123 });
logger.debug('Collecting device info', { platform: 'windows' });
```

## Configuration

- Use environment variables for configuration
- Support `config.json` file as fallback
- Validate required configuration on startup
- Never commit secrets or API keys
- Use `.env.example` for documentation

```typescript
export interface AgentConfig {
  apiUrl: string;
  apiKey: string;
  collectInterval: number;
  reportInterval: number;
  retryAttempts: number;
  retryDelay: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  assetTag?: string;
  deviceId?: number;
  collectSoftware: boolean;
}
```

## Data Collection Best Practices

### Collection Intervals
- Device info: Collect once or when changed (doesn't change frequently)
- Health metrics: Collect at regular intervals (changes frequently)
- Software list: Collect periodically (changes infrequently)
- Respect `collectInterval` from configuration

### Error Handling in Collectors
- Never throw errors that would crash the agent
- Log warnings for non-critical collection failures
- Return partial data when possible
- Use try-catch for each collection operation

```typescript
async collect(): Promise<DeviceInfo> {
  try {
    const hostname = os.hostname();
    // ... collect data
  } catch (error) {
    this.logger.warn('Failed to collect some device info', { error });
    // Return partial data or default values
  }
}
```

## API Communication

### Request Format
- Use Axios for all HTTP requests
- Include API key in headers: `X-API-Key`
- Use proper content types
- Handle timeouts appropriately
- Implement request/response interceptors if needed

```typescript
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 30000,
  headers: {
    'X-API-Key': config.apiKey,
    'Content-Type': 'application/json',
  },
});
```

### Offline Handling
- Queue reports when offline
- Retry queued reports when back online
- Process queue on agent startup
- Process queue on graceful shutdown

## Graceful Shutdown

- Handle SIGTERM and SIGINT signals
- Stop collection and reporting intervals
- Process any remaining queued reports
- Close connections and cleanup resources
- Exit with appropriate exit codes

```typescript
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  await agentService.stop();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

## TypeScript Best Practices

- Use strict mode
- Define interfaces for all data structures
- Avoid `any` type
- Use type inference where appropriate
- Export types from dedicated type files

```typescript
// types/device.ts
export interface DeviceInfo {
  hostname: string;
  platform: 'windows' | 'mac' | 'linux';
  osVersion: string;
  serialNumber: string | null;
  // ... more fields
}

export interface HealthMetrics {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  uptime: number;
}
```

## Testing

### Unit Tests
- Test collectors in isolation
- Mock systeminformation calls
- Test error handling scenarios
- Test retry logic

### Integration Tests
- Test API communication with mock server
- Test offline queue functionality
- Test device registration flow
- Test graceful shutdown

## Security Best Practices

1. **API Keys**: Never log API keys, use environment variables
2. **Network**: Use HTTPS in production
3. **Input Validation**: Validate all configuration values
4. **Error Messages**: Don't expose sensitive information in error messages
5. **Dependencies**: Keep dependencies up to date
6. **Permissions**: Run with minimal required permissions

## Feature Development Checklist

**Before implementing any feature, always check the following:**

1. **Check Backend API Availability**
   - Check if the required API endpoint(s) exist in the backend API specification (`novaris_api_spec.yaml` in the backend repository)
   - If the API does NOT exist:
     - Coordinate with backend team or create the API endpoint in the backend first
     - Ensure the API is documented in `novaris_api_spec.yaml`
   - If the API exists but needs modifications:
     - Update the API calls in the agent accordingly
     - Ensure API documentation is updated

2. **Check Existing Features**
   - Search the codebase for existing implementations of similar features
   - Check existing collectors, services, and utilities
   - If a similar feature already exists:
     - **Update the existing feature** instead of creating a new one
     - Extend or modify the existing code rather than duplicating functionality
   - If no similar feature exists:
     - Proceed with creating a new feature following SOLID principles

3. **Check Existing Collectors**
   - Before creating new collectors:
     - Check `src/collectors/` for existing collectors that can be extended
     - Check if existing collectors can collect the required data
     - **Use existing collectors** instead of creating new ones when possible
   - Only create new collectors if:
     - No existing collector can fulfill the requirement
     - The new collector provides significantly different functionality
     - The requirement cannot be met with existing collectors

4. **Check Existing Plugins/Packages**
   - Before installing any new npm package or plugin:
     - Check `package.json` to see if a similar package is already installed
     - Check if existing packages can fulfill the requirement
     - **Use existing plugins/packages** instead of installing new ones when possible
   - Only install new packages if:
     - No existing package can fulfill the requirement
     - The new package provides significantly better functionality
     - The requirement cannot be met with existing tools

## Task Management and Commit Workflow

**When working on multiple tasks or a list of tasks, follow these guidelines:**

1. **Work Task by Task**
   - **Always work on one task at a time** - Never attempt to complete all tasks in a list simultaneously
   - Complete one task fully before moving to the next
   - This ensures focused work, better code quality, and easier review process

2. **Request Review for Each Task**
   - **Always ask for review** after completing each task
   - Present the changes made for the current task
   - Wait for confirmation/approval before proceeding to the next task
   - This allows for early feedback and prevents accumulating issues

3. **Commit Confirmed Changes**
   - **Always create a commit** for changes that have been confirmed/approved
   - Never commit unconfirmed or work-in-progress changes
   - Each task should result in at least one commit (or multiple logical commits if the task is large)

4. **Commit Message Format**
   - **Commit message format**: `[TASK-XXX] Short description of task`
   - If task number is available (e.g., TASK-123, ISSUE-456), use it as a prefix
   - If no task number is available, use a descriptive prefix like `[FEATURE]`, `[FIX]`, `[REFACTOR]`, etc.
   - Follow the task number with a short, clear description of what was done
   - Examples:
     - `[TASK-123] Add network metrics collector`
     - `[TASK-456] Fix retry logic in reporting service`
     - `[FEATURE] Implement offline queue persistence`
     - `[FIX] Resolve memory leak in health metrics collector`

5. **Continue to Next Task**
   - **Always ask for permission** to continue to the next task unless explicitly told to continue without approval
   - After receiving review confirmation and creating the commit, ask: "Should I continue to the next task?"
   - Do not proceed to the next task automatically unless instructed to do so
   - This ensures proper workflow control and allows for prioritization changes

### Example Workflow:
```
1. Work on Task 1 → Complete implementation
2. Ask for review: "Task 1 is complete. Please review the changes."
3. Receive confirmation/feedback
4. Create commit: `[TASK-1] Add network metrics collector`
5. Ask: "Should I continue to Task 2?"
6. Wait for approval before proceeding
7. Repeat for each subsequent task
```

## Development Workflow

1. **Create Feature Branch**: `git checkout -b feature/network-metrics-collector`
2. **Follow Feature Development Checklist**: Complete all checks above before implementation
3. **Write Tests First**: TDD approach preferred
4. **Implement Feature**: Follow SOLID principles
5. **Update Documentation**: 
   - Update README if changes are related to something that needs to be documented
   - Update configuration examples if config changes
6. **Run Tests**: Ensure all tests pass
7. **Test Agent**: Test the agent locally with the backend
8. **Code Review**: Submit PR with clear description
9. **Merge**: After approval and CI passes

## Example: Complete Feature Implementation

### 1. Type Definition
```typescript
// types/device.ts
export interface NetworkMetrics {
  interfaces: Array<{
    name: string;
    speed: number;
    bytesReceived: number;
    bytesSent: number;
  }>;
  totalBytesReceived: number;
  totalBytesSent: number;
}
```

### 2. Collector
```typescript
// collectors/networkCollector.ts
import * as si from 'systeminformation';
import { NetworkMetrics } from '../types/device';
import { getLogger } from '../utils/logger';

export class NetworkCollector {
  private logger = getLogger();

  async collect(): Promise<NetworkMetrics> {
    try {
      const networkStats = await si.networkStats();
      // Process and return network metrics
      return networkMetrics;
    } catch (error) {
      this.logger.error('Failed to collect network metrics', { error });
      throw error;
    }
  }
}
```

### 3. Service Integration
```typescript
// services/agentService.ts
private networkCollector: NetworkCollector;

constructor(private config: AgentConfig) {
  // ... existing collectors
  this.networkCollector = new NetworkCollector();
}

private async reportData(): Promise<void> {
  // ... existing collection
  const networkMetrics = await this.networkCollector.collect();
  // Include in report
}
```

## Important Rules Summary

1. **Always follow SOLID principles** - No exceptions
2. **Feature Development Checklist** - Always check API availability, existing features, existing collectors, and existing plugins before implementing
3. **Task Management** - Work on one task at a time, never attempt all tasks simultaneously
4. **Request Review** - Always ask for review after completing each task before proceeding
5. **Commit Confirmed Changes** - Always create a commit for confirmed/approved changes
6. **Commit Message Format** - Use `[TASK-XXX] Short description` format with task number prefix when available
7. **Ask Before Continuing** - Always ask for permission to continue to the next task unless explicitly told to continue
8. **Error Handling** - Never crash the agent on non-critical errors, always implement retry logic
9. **Logging** - Use structured logging with appropriate log levels
10. **Configuration** - Use environment variables, validate on startup
11. **Type Safety** - Use TypeScript properly, avoid `any` type
12. **Graceful Shutdown** - Always handle shutdown signals properly
13. **Offline Support** - Queue reports when offline, retry when online
14. **Security** - Never log sensitive information, use HTTPS in production
15. **Reuse Existing Code** - Always check for existing features and update them instead of creating duplicates
16. **Reuse Existing Packages** - Use existing plugins/packages instead of installing new ones when possible

