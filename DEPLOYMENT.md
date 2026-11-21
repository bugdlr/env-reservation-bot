# Deployment Guide for SDLC Bot

## Requirements

- Node.js 22
- Outbound network access to Slack (`slack.com`, `wss-primary.slack.com`); no inbound traffic, load balancer or TLS certificate
- `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (see `environment-template.txt`); `MONITORED_CHANNELS` optional

## Run exactly one instance

Reservations, queues and their timers live in process memory and are rebuilt from each channel's pinned status message on startup. Two instances would hold separate state and could hand the same environment to two people, so run a single replica and let restarts recover from the pinned message.

The process must stay running between requests (expirations, reminders and the 3-minute handoff timeout are in-process timers), so platforms that sleep or throttle CPU between requests (Lambda, App Runner) don't fit.

## Docker

```bash
docker build -t sdlc-bot .
docker run -d --name sdlc-bot --env-file .env sdlc-bot
```

## Health checks

- `GET /health`: Slack API connectivity plus reservation counts (also the Docker `HEALTHCHECK`)
- `GET /ready`: both tokens configured

## Troubleshooting

1. **"Missing scope"**: compare the app's Bot Token Scopes with the list in the README
2. **Bot not responding to commands**: check the logs for `Connected to Slack via Socket Mode`, and that Socket Mode and Interactivity are both on in the Slack app
