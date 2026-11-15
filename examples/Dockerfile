# A starting point for your own t3 image: the minimal one (images/t3), plus
# what agents use to get work done. Copy it and make it yours.
#
#   docker build -t t3:base images/t3
#   docker build -t my-registry/t3 --build-arg BASE=t3:base examples
#
# images/t3 has t3 (with its token file, for the operator), git and ssh, and
# no Node: the t3 executable embeds its own. Agents need more: here Node, the
# Claude Code CLI (t3's Claude provider runs it), and everyday tools.

ARG BASE=t3:base
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM ${BASE}
USER root

# Tools agents reach for. Add your project's toolchains here (python3, go,
# a JDK, ...).
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl jq less ripgrep unzip make \
  && rm -rf /var/lib/apt/lists/*

# Node and npm, from the official image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && node --version && npm --version

# Provider CLIs, installed globally under /usr/local, outside $HOME: a home
# volume (as in the README's StatefulSet) would hide anything installed
# there. Log in from t3 once the pod is up; the login lives in $HOME, so it
# survives restarts.
RUN npm install -g @anthropic-ai/claude-code && claude --version
# RUN npm install -g @openai/codex && codex --version

USER t3
