# Build client
FROM node:24-alpine AS client-builder
WORKDIR /app
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN npx vite build

# Build server
FROM node:24-alpine AS server-builder
WORKDIR /app
COPY server/package*.json ./
COPY server/prisma ./prisma
RUN npm ci
COPY server/ ./
RUN npm run build

# Production image
FROM node:24-alpine
WORKDIR /app

# Pull the latest system CA store (eMudhra intermediate distrust, Oct 2026)
RUN apk upgrade --no-cache ca-certificates

# Copy prisma schema before npm ci so prisma generate can find it
COPY server/package*.json ./
COPY server/prisma ./prisma
RUN npm ci

# Copy compiled server and built client
COPY --from=server-builder /app/dist ./dist
COPY --from=client-builder /app/dist ./public

ENV NODE_ENV=production
EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npx prisma db seed && node dist/index.js"]
