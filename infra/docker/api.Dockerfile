# syntax=docker/dockerfile:1
FROM node:22.23.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY . .
WORKDIR /app
CMD ["node", "--version"]
