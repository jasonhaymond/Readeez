# Dockerfile
# Builds the Readeez server image in two stages. The first builds the browser version of the app from the same code
# as the Android app, and is then thrown away, so its large development packages never reach the running server. The
# second holds only the API and those finished web files. Built from the repo's top folder (see docker-compose.yml),
# because the web app's code lives there. Node 24 is the current LTS. Alpine keeps the image small, and bcrypt ships a
# ready-built binary for it, so no compiler is needed. .dockerignore keeps secrets out of the build.

FROM node:24-alpine AS web
WORKDIR /build
# Installed before the code is copied, so Docker can reuse this slow step when only the code changes. `npm ci` installs
# exactly what the lockfile says.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The server address stays empty: a page talks to the server it was loaded from. Telemetry is off so a build reports
# nothing to anyone.
RUN EXPO_NO_TELEMETRY=1 npx expo export --platform web --output-dir /web

FROM node:24-alpine
WORKDIR /app
# Dev tools are left out of the running server.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=web /web ./public
ENV WEB_ROOT=/app/public

# Runs as Node's unprivileged user, so a compromised server process doesn't have root
# inside the container.
USER node
EXPOSE 3000
CMD ["node", "index.js"]
