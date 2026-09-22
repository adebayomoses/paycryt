FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY packages ./packages
COPY examples ./examples
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=build /app /app
EXPOSE 8787
USER node
CMD ["node", "packages/server/dist/cli.js"]
