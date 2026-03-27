# 🚀 AWS Deployment Guide for SDLC Bot

## 🎯 **Questions for Your AWS/DevOps Team**

Ask them: *"Which AWS service do you typically use for deploying Node.js applications?"*

## 📋 **Common AWS Deployment Options**

### **Option 1: AWS App Runner** (Easiest)
✅ **Best for:** Simple containerized deployment, minimal configuration  
✅ **Your IT team handles:** Almost everything automatically

**What you need to provide:**
- This GitHub repository URL
- Environment variables (see below)

**Configuration file needed:**
```yaml
# apprunner.yaml
version: 1.0
runtime: docker
build:
  commands:
    build:
      - echo "No build commands needed - using Dockerfile"
run:
  runtime-version: latest
  command: npm start
  network:
    port: 3000
    env: PORT
  env:
    - name: NODE_ENV
      value: production
```

### **Option 2: AWS ECS (Fargate)** (Most Common)
✅ **Best for:** Production workloads, scaling, monitoring  
✅ **Your IT team handles:** Load balancing, auto-scaling, networking

**Task Definition Template:**
```json
{
  "family": "sdlc-bot",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "sdlc-bot",
      "image": "your-account.dkr.ecr.region.amazonaws.com/sdlc-bot:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        }
      ],
      "secrets": [
        {
          "name": "SLACK_BOT_TOKEN",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:slack-bot-token"
        },
        {
          "name": "SLACK_SIGNING_SECRET", 
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:slack-signing-secret"
        }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/sdlc-bot",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

### **Option 3: AWS Elastic Beanstalk** (Simple)
✅ **Best for:** Quick deployment, Git-based workflow  
✅ **Your IT team handles:** Infrastructure provisioning

**Configuration files needed:**

`.ebextensions/nodecommand.config`:
```yaml
option_settings:
  aws:elasticbeanstalk:container:nodejs:
    NodeCommand: "npm start"
  aws:elasticbeanstalk:application:environment:
    NODE_ENV: production
    PORT: 8080
```

`.platform/nginx/conf.d/proxy.conf`:
```nginx
upstream nodejs {
    server 127.0.0.1:8080;
    keepalive 256;
}

server {
    listen 80;

    location / {
        proxy_pass  http://nodejs;
        proxy_set_header   Connection "";
        proxy_http_version 1.1;
        proxy_set_header        Host            $host;
        proxy_set_header        X-Real-IP       $remote_addr;
        proxy_set_header        X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass  http://nodejs/health;
        access_log off;
    }
}
```

### **Option 4: AWS Lambda** (Serverless)
⚠️ **Note:** Requires code modifications for serverless architecture

**If your team wants serverless, we'll need to:**
1. Add `serverless` framework or AWS SAM
2. Modify the Express app to work with Lambda events
3. Handle state differently (use DynamoDB instead of in-memory)

## 🔐 **AWS Secrets Management**

**Recommended approach for production:**

### Using AWS Secrets Manager:
```bash
# Your IT team creates secrets like this:
aws secretsmanager create-secret \
  --name "sdlc-bot/slack-bot-token" \
  --secret-string "xoxb-your-actual-token"

aws secretsmanager create-secret \
  --name "sdlc-bot/slack-signing-secret" \
  --secret-string "your-actual-signing-secret"
```

### Using AWS Parameter Store (alternative):
```bash
aws ssm put-parameter \
  --name "/sdlc-bot/slack-bot-token" \
  --value "xoxb-your-actual-token" \
  --type "SecureString"

aws ssm put-parameter \
  --name "/sdlc-bot/slack-signing-secret" \
  --value "your-actual-signing-secret" \
  --type "SecureString"
```

## 🌐 **Load Balancer & SSL**

**Questions for your team:**
- *"Will you set up an Application Load Balancer?"*
- *"Do you handle SSL certificates, or should I configure HTTPS in the app?"*
- *"What domain name will this run on?"*

**Typical setup:**
```
Internet → ALB (with SSL) → ECS/App Runner → Your Bot
```

## 📊 **Monitoring & Logging**

**The bot is ready for AWS monitoring:**

### CloudWatch Integration:
- Logs automatically go to CloudWatch Logs
- Health checks work with ALB health checks
- `/health` and `/ready` endpoints for monitoring

### Metrics to monitor:
- HTTP response times
- Error rates
- Active reservations count (available at `/health`)
- Memory/CPU usage

## 🚀 **Deployment Steps for IT Team**

### For ECS Deployment:
1. **Build & Push to ECR:**
   ```bash
   # Build image
   docker build -t sdlc-bot .
   
   # Tag for ECR
   docker tag sdlc-bot:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/sdlc-bot:latest
   
   # Push to ECR
   docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/sdlc-bot:latest
   ```

2. **Create ECS Service:**
   - Use the task definition above
   - Set up load balancer target group
   - Configure auto-scaling (1-3 instances recommended)

3. **Configure secrets in AWS Secrets Manager**

4. **Update Slack app URLs** to point to ALB domain

### For App Runner:
1. Connect to your GitHub repository
2. Use the `apprunner.yaml` configuration
3. Set environment variables in App Runner console
4. App Runner handles the rest!

## 🔧 **Infrastructure as Code**

If your team uses **Terraform** or **CloudFormation**, I can help create those templates too. Just let me know!

## 📋 **Security Checklist for AWS**

- [ ] Use AWS Secrets Manager or Parameter Store for tokens
- [ ] Run containers as non-root user (already configured)
- [ ] Enable VPC security groups to restrict access
- [ ] Use ALB with SSL termination
- [ ] Enable CloudWatch logging
- [ ] Set up IAM roles with minimal permissions
- [ ] Configure health checks 