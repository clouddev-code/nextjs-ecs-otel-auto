FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next.js standalone server.js binds to $HOSTNAME if set. Docker sets HOSTNAME to the
# container ID by default, which resolves (via /etc/hosts) to the container's own IP only
# -- not 127.0.0.1 -- breaking same-container loopback requests (e.g. the "/" page's
# server-side fetch to "/api/hello"). Force it to listen on all interfaces instead.
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
