# Dockerfile
# Builds the Readeez API server image. Node 24 is the current LTS. Alpine keeps the image
# small, and bcrypt ships a ready-built binary for it, so no compiler is needed.
FROM node:24-alpine
WORKDIR /app

# Dependencies install before the code is copied, so Docker can reuse this layer when only
# the code changes. `npm ci` installs exactly what the lockfile says; dev tools are left out.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Runs as Node's unprivileged user, so a compromised server process doesn't have root
# inside the container.
USER node
EXPOSE 3000
CMD ["node", "index.js"]
