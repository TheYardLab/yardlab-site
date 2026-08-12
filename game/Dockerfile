# Portable alternative to render.yaml — works on Fly.io, Railway, a VPS, or
# anywhere else that runs a container. Build from inside game/.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so the layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY server.js ./

USER node
EXPOSE 3000
CMD ["npm", "start"]
