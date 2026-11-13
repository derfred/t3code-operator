# The operator image. No dependencies and no build step: Node 24 runs the
# TypeScript directly, stripping its types.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
# Where Kubernetes mounts the service account's CA: fetch() trusts the API
# server through it.
ENV NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
ENV NODE_OPTIONS=--dns-result-order=ipv4first
USER node
ENTRYPOINT ["node", "/app/src/main.ts"]
