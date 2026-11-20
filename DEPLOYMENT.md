# 🚀 Deployment Guide for SDLC Bot

## Environment Requirements

**Minimum:**
- Node.js 14+ (tested with Node 18)
- 512MB RAM
- 1 CPU core
- Network access to Slack API (slack.com)

**Environment Variables Required:**
```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
PORT=3000  # Optional, defaults to 3000
MONITORED_CHANNELS=C1234567890,C0987654321  # Optional
```

## 🎯 **Questions for Your IT Team**

### **Deployment Method**
Ask your IT team: *"What deployment method do you prefer?"*

1. **Docker** (most common) - We have a Dockerfile ready
2. **Traditional server** - Direct Node.js installation
3. **Cloud platform** - AWS, GCP, Azure
4. **Platform-as-a-Service** - Heroku, Railway, etc.

### **Networking & Security**
- *"What port should the app run on?"* (currently set to 3000)
- *"Do I need to configure any firewall rules?"*
- *"What's the external URL where Slack will reach the bot?"*
- *"Do you handle SSL/TLS termination, or should the app?"*

### **Secrets Management**
- *"How do you handle environment variables/secrets?"*
- *"Should I put the Slack tokens in a secrets manager?"*

### **Monitoring**
- *"Do you have monitoring tools I should integrate with?"*
- *"The app has `/health` and `/ready` endpoints - do you need those?"*

## 📋 **Common Deployment Scenarios**

### Option 1: Docker (Recommended)
```bash
# Build the image
docker build -t sdlc-bot .

# Run with environment variables
docker run -d \
  --name sdlc-bot \
  -p 3000:3000 \
  -e SLACK_BOT_TOKEN=xoxb-your-token \
  -e SLACK_SIGNING_SECRET=your-secret \
  sdlc-bot
```

### Option 2: Traditional Server
```bash
# Install dependencies
npm install --production

# Set environment variables
export SLACK_BOT_TOKEN=xoxb-your-token
export SLACK_SIGNING_SECRET=your-secret

# Start the app
npm start
```

### Option 3: Cloud Platform
Most cloud platforms can deploy directly from this Git repository using the `package.json` scripts.

## 🔧 **Health Checks**

The app provides monitoring endpoints:
- `GET /health` - Basic health check
- `GET /ready` - Readiness check with Slack API test

## 🔄 **Updating the App**

When you need to update:
1. Update the code
2. Restart the service (Docker: rebuild image)
3. No database migrations needed (uses in-memory state)

## 📞 **Slack Configuration**

**After deployment, configure these Slack settings:**

### Slash Commands
- `/env-request` → `https://your-domain.com/env-request`
- `/env-release` → `https://your-domain.com/env-release`
- `/env-leave-queue` → `https://your-domain.com/env-leave-queue`
- `/env-status` → `https://your-domain.com/env-status`

### Interactive Components
- Request URL: `https://your-domain.com/slack/interactions`

### Event Subscriptions (Optional)
- Request URL: `https://your-domain.com/slack/events`

## 🛡️ **Security Notes**

- App validates all Slack requests with signature verification
- Rate limiting: 10 requests/minute per user
- No database or persistent storage of sensitive data
- Runs as non-root user in Docker
- Input validation on all user commands

## 🚨 **Troubleshooting**

### Check if app is running:
```bash
curl http://localhost:3000/health
```

### Common issues:
1. **"Missing scope"** - Add `channels:read`, `channels:history`, `channels:write`, `chat:write`, `pins:write` to Slack app Bot Token Scopes
2. **"Invalid signature"** - Check `SLACK_SIGNING_SECRET` matches Slack app
3. **"Bot not responding"** - Verify Slack can reach your deployment URL

## 📋 **Production Checklist**

Before going live:
- [ ] Environment variables set correctly
- [ ] Health check endpoints responding
- [ ] Slack can reach the deployment URL
- [ ] SSL/TLS configured (if needed)
- [ ] Monitoring/logging configured
- [ ] Slack slash commands pointing to correct URLs 