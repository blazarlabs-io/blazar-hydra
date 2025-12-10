# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma (Alpine Linux)
RUN apk add --no-cache openssl openssl-dev

# Copy package files
COPY src/package*.json ./
COPY src/tsconfig.json ./

# Install dependencies (including Prisma CLI which is needed)
RUN npm ci

# Copy Prisma schema
COPY src/prisma/schema.prisma ./prisma/

# Generate Prisma Client
RUN npx prisma generate

# Copy source code
COPY src/ ./

# Build TypeScript (tsc-alias will resolve paths, but we'll use a loader instead)
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL and OpenSSH for Prisma and SSH server (Alpine Linux)
RUN apk add --no-cache openssl openssl-dev openssh

# Copy package files
COPY src/package*.json ./

# Install production dependencies (Prisma CLI is needed for db push)
# Note: prisma is in dependencies, so it will be installed
RUN npm ci --omit=dev && npm cache clean --force

# Copy Prisma generated client from builder  
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy source code (we'll run from source with tsx instead of compiled JS)
# Note: In builder, src files are copied directly to /app/ with COPY src/ ./
COPY --from=builder /app/api ./api
COPY --from=builder /app/config.ts ./config.ts
COPY --from=builder /app/offchain ./offchain
COPY --from=builder /app/onchain ./onchain
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/tsconfig.json ./

# Copy package.json to ensure ESM module type is recognized
COPY --from=builder /app/package.json ./

# Install tsx for production (it handles ESM imports automatically)
RUN npm install tsx --save-prod && npm cache clean --force

# Create directory for database
RUN mkdir -p ./prisma/prisma

# Configure SSH server
RUN mkdir -p /var/run/sshd && \
    ssh-keygen -A && \
    echo "Port 2222" >> /etc/ssh/sshd_config && \
    echo "PermitRootLogin yes" >> /etc/ssh/sshd_config && \
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config && \
    echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config && \
    echo "root:root" | chpasswd

# Expose ports
EXPOSE 3000 2222

# Optional: Add healthcheck if you have a /health endpoint
# HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
#   CMD node -e "require('http').get('http://localhost:${PORT || 3000}/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Start SSH server and initialize database schema and start dev server
CMD ["sh", "-c", "/usr/sbin/sshd -D & npx prisma db push --accept-data-loss && npm run dev"]
