# Multi-stage build for production-ready image
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Production stage
FROM node:20-alpine AS production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S retell -u 1001 -G nodejs

# Install security updates
RUN apk upgrade --no-cache

# Set working directory
WORKDIR /app

# Copy dependencies from builder stage
COPY --from=builder --chown=retell:nodejs /app/node_modules ./node_modules

# Copy application source
COPY --chown=retell:nodejs src/ ./src/
COPY --chown=retell:nodejs package*.json ./

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Security: Run as non-root user
USER retell

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "const http = require('http'); \
    const options = { hostname: 'localhost', port: 3000, path: '/healthz', timeout: 5000 }; \
    const req = http.request(options, (res) => { \
    process.exit(res.statusCode === 200 ? 0 : 1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.on('timeout', () => process.exit(1)); \
    req.end();"

# Start the application
CMD ["node", "src/index.js"]

# Metadata
LABEL maintainer="Ardent Team"
LABEL description="Retell Processor - Kubernetes-ready microservice for processing survey responses"
LABEL version="1.0.0"