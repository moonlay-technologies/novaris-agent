# Novaris Agent

Device monitoring agent for the Novaris Asset Management System.

## Features

- Cross-platform support (Windows, macOS, Linux)
- Automatic device registration
- Health metrics collection (CPU, RAM, Disk, Uptime)
- Software inventory collection
- Periodic reporting to backend API
- Offline queue with automatic retry
- Configurable collection and reporting intervals

## Installation

### From Source

```bash
npm install
npm run build
npm start
```

### Configuration

Create a `config.json` file in the agent directory:

```json
{
  "apiUrl": "http://localhost:3000/api/v1",
  "apiKey": "your-api-key-here",
  "collectInterval": 300,
  "reportInterval": 300,
  "retryAttempts": 3,
  "retryDelay": 1000,
  "logLevel": "info"
}
```

Or use environment variables:

- `NOVARIS_API_URL` - Backend API URL
- `NOVARIS_API_KEY` - API key for authentication
- `NOVARIS_COLLECT_INTERVAL` - Collection interval in seconds (default: 300)
- `NOVARIS_REPORT_INTERVAL` - Reporting interval in seconds (default: 300)
- `NOVARIS_LOG_LEVEL` - Log level (error, warn, info, debug)

## Development

```bash
npm run dev
```

## Building

```bash
npm run build
```

## Logs

Logs are stored in the `logs/` directory:
- `novaris-agent.log` - Main application log
- `exceptions.log` - Unhandled exceptions
- `rejections.log` - Unhandled promise rejections

