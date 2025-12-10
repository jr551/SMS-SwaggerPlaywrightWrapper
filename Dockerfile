FROM mcr.microsoft.com/playwright:v1.57.0-noble

LABEL org.opencontainers.image.source="https://github.com/jr551/smsauto"
LABEL org.opencontainers.image.description="SMS automation service via router web UI"

WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
RUN npm install --production

# Add source
COPY src ./src

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=3324

EXPOSE 3324

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3324/healthz || exit 1

CMD ["npm", "start"]
