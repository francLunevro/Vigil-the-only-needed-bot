FROM node:24-slim

WORKDIR /app

COPY package*.json ./
# Lockfile-driven install: npm ci installs exactly the tree CI tested.
# (better-sqlite3 publishes a prebuilt linux-x64 binary for Node 24's ABI 137,
# so this image needs no build toolchain.)
RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

# /health is served unauthenticated, so the container reports unhealthy when
# the bot process is wedged instead of merely "running".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]