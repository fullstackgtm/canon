# Use the official Node image through AWS's public mirror.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim
ARG RELEASE_GIT_SHA
LABEL org.opencontainers.image.revision=$RELEASE_GIT_SHA
ENV GIT_SHA=$RELEASE_GIT_SHA
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ENV DATA_DIR=/data HOST=0.0.0.0
EXPOSE 8787
# exec form so SIGTERM reaches node directly (graceful drain + CHECKPOINT)
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/main.ts"]
