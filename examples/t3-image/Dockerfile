# A small t3 server image for the operator to manage, and a starting point
# for your own: t3 built from the derfred/t3code fork, whose
# `t3 serve --auth-token-file` (or T3CODE_AUTH_TOKEN_FILE) accepts a bearer
# token you choose (README.md, Tokens, the first way), plus Claude Code, which
# t3's Claude provider runs, and uv for Python.
#
#   docker build -t t3 examples/t3-image
#   docker build -t t3 --build-arg T3_REF=<commit> examples/t3-image      # pin a commit
#
# Multi-stage: each tool is fetched or built in a stage of its own, and only
# its result is copied into a Debian slim base. No Node: t3 and Claude Code
# are self-contained executables. To add a tool, give it a stage and copy
# what it installs; keep what it creates at runtime in $HOME, on the pod's
# home volume.

ARG UV_VERSION=0.13.7

# ─── t3, from the fork ──────────────────────────────────────────────────────
FROM node:24-bookworm AS t3
ARG T3_REPO=https://github.com/derfred/t3code.git
ARG T3_REF=feat/server-auth-token-file
ARG TARGETARCH
COPY build-t3.sh /usr/local/bin/build-t3
RUN case "$TARGETARCH" in \
      amd64 | "") arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bash /usr/local/bin/build-t3 "$T3_REPO" "$T3_REF" "$arch" /out

# ─── Claude Code: npm delivers a native binary; only that is kept ──────────
FROM node:24-bookworm-slim AS claude
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && cp -L "$(command -v claude)" /claude \
 && /claude --version

# ─── uv and uvx, from Astral's image ────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# ─── the image ──────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client procps curl less ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY --from=t3 /out /usr/local/lib/t3
# A wrapper, not a symlink: t3 finds client/ and its node_modules next to
# the executable it was started as.
RUN printf '#!/bin/sh\nexec /usr/local/lib/t3/t3 "$@"\n' > /usr/local/bin/t3 \
  && chmod 0755 /usr/local/bin/t3
COPY --from=claude /claude /usr/local/bin/claude
COPY --from=uv /uv /uvx /usr/local/bin/
RUN t3 --version && claude --version && uv --version

# The image is rebuilt to update Claude Code: it can't update itself in
# /usr/local, and shouldn't try. Its login and settings live in $HOME.
ENV DISABLE_AUTOUPDATER=1

# uid/gid 1000, as the README's StatefulSet runs it (runAsUser, fsGroup),
# with its home where that StatefulSet mounts t3's data: threads, settings,
# the Claude login, uv's Pythons and cache.
RUN groupadd --gid 1000 t3 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/node t3 \
  && mkdir /workspace && chown t3:t3 /workspace
ENV HOME=/home/node
WORKDIR /workspace
USER t3
EXPOSE 3773

# On all addresses, so the operator reaches it on the pod's IP. Set
# T3CODE_AUTH_TOKEN_FILE to the token file's path.
CMD ["t3", "serve", "--host", "0.0.0.0", "--port", "3773"]
