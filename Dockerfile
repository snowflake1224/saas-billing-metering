FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm build
EXPOSE 3000 4000
CMD ["pnpm","dev"]
