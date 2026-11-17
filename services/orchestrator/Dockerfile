# syntax=docker/dockerfile:1
# Worker image. Build from the repository root:
#   docker build -f services/orchestrator/Dockerfile -t vx-worker .
# Behind a TLS-intercepting proxy, pass its CA as a build secret (not baked into the image):
#   docker build --secret id=extra_ca,src=/path/to/ca.crt -f services/orchestrator/Dockerfile -t vx-worker .
FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/orchestrator ./services/orchestrator
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && pnpm install --frozen-lockfile --filter "@vx/orchestrator..." && pnpm store prune
USER node
CMD ["node", "services/orchestrator/src/main.ts"]
