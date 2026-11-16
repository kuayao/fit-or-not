FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global npm@11.19.1 && npm ci
COPY server/ server/
COPY miniprogram/api/contracts.ts miniprogram/api/contracts.ts
COPY miniprogram/utils/layout.ts miniprogram/utils/layout.ts
RUN npm run build && npm prune --omit=dev

FROM node:24.22.3-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY server/migrations/ server/migrations/
COPY deploy/start.mjs deploy/start.mjs
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3006 MEDIA_DIR=/app/media
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app && mkdir /app/media && chown app:app /app/media
USER app
EXPOSE 3006
ENTRYPOINT ["node", "deploy/start.mjs"]
CMD ["api"]
