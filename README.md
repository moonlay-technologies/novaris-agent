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

### Getting an API Key

1. **Login to the backend** as an admin/superadmin user
2. **Generate an API key** via the API:
   ```bash
   curl -X POST http://localhost:3000/api/v1/api-key/generate \
     -H "Authorization: Bearer YOUR_JWT_TOKEN"
   ```
3. **Set the API key** in your backend environment variable:
   ```bash
   export API_KEY="your-generated-key-here"
   ```
   Or add to `.env` file: `API_KEY=your-generated-key-here`
4. **Restart the backend server**

### Agent Configuration

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
- `NOVARIS_API_KEY` - API key for authentication (get from backend admin)
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

