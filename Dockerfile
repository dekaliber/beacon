# Build client
FROM node:20-alpine AS client-builder
WORKDIR /app
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Build server
FROM node:20-alpine AS server-builder
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# Production image
FROM node:20-alpine
WORKDIR /app

# Copy prisma schema before npm ci so prisma generate can find it
COPY server/package*.json ./
COPY server/prisma ./prisma
RUN npm ci

# Copy compiled server and built client
COPY --from=server-builder /app/dist ./dist
COPY --from=client-builder /app/dist ./public

ENV NODE_ENV=production
EXPOSE 3001

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
