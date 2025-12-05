import { loadConfig } from './utils/config';
import { createLogger } from './utils/logger';
import { AgentService } from './services/agentService';

async function main() {
  try {
    // Load configuration
    const config = loadConfig();

    // Initialize logger
    const logger = createLogger(config);

    logger.info('Novaris Agent starting...');
    logger.info(`API URL: ${config.apiUrl}`);
    logger.info(`Collect Interval: ${config.collectInterval}s`);
    logger.info(`Report Interval: ${config.reportInterval}s`);

    // Create and start agent service
    const agentService = new AgentService(config);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      await agentService.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle unhandled errors
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', { promise, reason });
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });

    // Start the agent
    await agentService.start();
  } catch (error) {
    console.error('Failed to start agent:', error);
    process.exit(1);
  }
}

// Start the application
main();

