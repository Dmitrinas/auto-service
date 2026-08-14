FROM node:22-alpine

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source
COPY server.js db.js ./
COPY public ./public

# Persistent data (mount a volume here in production)
ENV DATA_DIR=/var/data
ENV NODE_ENV=production
ENV PORT=3000
VOLUME ["/var/data"]

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
