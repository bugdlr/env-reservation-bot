# SDLC Bot

A Slack bot for managing shared environment reservations. Teams can reserve, queue, and release environments through slash commands with automatic expiration and reminders.

## Features

- **Reserve environments** with optional duration (defaults to 1 hour)
- **Automatic queue** when an environment is occupied — next in line gets notified
- **Auto-release** after the reservation expires
- **Reminders** sent via DM before expiration
- **Multi-channel support** — deploy to multiple Slack channels, each with independent environment state
- **Pinned status messages** kept up to date in each channel
- **Startup recovery** — checks for expired reservations on boot

## Quick Start

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.

### 2. Configure Bot Token Scopes

Under **OAuth & Permissions**, add these Bot Token Scopes:

- `channels:read`
- `channels:history`
- `channels:write`
- `chat:write`
- `pins:write`
- `im:write`

### 3. Create Slash Commands

Under **Slash Commands**, create these four commands, all pointing to `https://your-domain.com/slack/slash-commands`:

| Command | Description |
|---------|-------------|
| `/env-request` | Reserve an environment or join the queue |
| `/env-release` | Release your current reservation |
| `/env-leave-queue` | Leave the waiting queue |
| `/env-status` | Show current environment status |

### 4. Enable Interactivity

Under **Interactivity & Shortcuts**, set the Request URL to:
```
https://your-domain.com/slack/interactions
```

### 5. Install and Configure

```bash
cp environment-template.txt .env
# Edit .env with your Slack bot token and signing secret

npm install
npm start
```

The bot runs on port 3000 by default.

## Usage

```
/env-request 2h          # Reserve for 2 hours
/env-request 30m         # Reserve for 30 minutes
/env-request             # Reserve for 1 hour (default)
/env-release             # Release your reservation
/env-leave-queue         # Leave the queue
/env-status              # Check who has the environment
```

When you request an environment that's already taken, you're automatically added to the queue and notified via DM when it's your turn.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions covering Docker, traditional servers, and cloud platforms.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | App signing secret for request verification |
| `PORT` | No | Server port (default: `3000`) |
| `MONITORED_CHANNELS` | No | Comma-separated channel IDs to check on startup |

See `environment-template.txt` for a complete example.

## License

ISC
