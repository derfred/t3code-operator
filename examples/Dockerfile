# A starting point for your own t3 image: the minimal one (images/t3), plus
# what agents use to get work done. Copy it and make it yours.
#
#   docker build -t t3:base images/t3
#   docker build -t my-registry/t3 --build-arg BASE=t3:base examples
#
# images/t3 has t3 (with its token file, for the operator), git and ssh, and
# no Node: the t3 executable embeds its own. Agents need more: here Node, the
# Claude Code CLI (t3's Claude provider runs it), everyday tools, and
# language toolchains (rbenv for Ruby, uv for Python) as examples to follow.
#
# The pattern for each tool: the tool itself under /usr/local, at a pinned
# version (an ARG); what it installs at runtime (Rubies, Pythons, caches) in
# $HOME, which the StatefulSet keeps on a volume, so it survives restarts and
# a new image doesn't rebuild it.

ARG BASE=t3:base
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM ${BASE}
USER root

# Tools agents reach for, and the libraries ruby-build compiles Ruby against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl jq less ripgrep unzip make build-essential \
      libssl-dev libyaml-dev libreadline-dev zlib1g-dev libffi-dev libgmp-dev \
  && rm -rf /var/lib/apt/lists/*

# Node and npm, from the official image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && node --version && npm --version

# rbenv, from its release tag, outside $HOME. The Rubies it installs go to
# RBENV_ROOT, on the home volume. The shims are on PATH directly, so
# non-interactive agent shells get them without `rbenv init`. In the pod:
# `rbenv install 3.4.7 && rbenv global 3.4.7`, or a project's .ruby-version.
ARG RBENV_VERSION=1.3.2
ENV RBENV_ROOT=/home/node/.rbenv
ENV PATH=/home/node/.rbenv/shims:$PATH
RUN mkdir -p /usr/local/lib/rbenv \
  && curl -fsSL "https://github.com/rbenv/rbenv/archive/refs/tags/v${RBENV_VERSION}.tar.gz" \
     | tar -xz -C /usr/local/lib/rbenv --strip-components 1 \
  && ln -s /usr/local/lib/rbenv/bin/rbenv /usr/local/bin/rbenv \
  && rbenv --version

# ruby-build, into /usr/local, where `rbenv install` finds it.
ARG RUBY_BUILD_VERSION=20261023
RUN mkdir /tmp/ruby-build \
  && curl -fsSL "https://github.com/rbenv/ruby-build/archive/refs/tags/v${RUBY_BUILD_VERSION}.tar.gz" \
     | tar -xz -C /tmp/ruby-build --strip-components 1 \
  && PREFIX=/usr/local /tmp/ruby-build/install.sh \
  && rm -rf /tmp/ruby-build \
  && ruby-build --version

# uv and uvx, checksum-verified. Pythons (`uv python install`) and its cache
# go to ~/.local/share/uv and ~/.cache/uv, on the home volume.
ARG UV_VERSION=0.13.7
ARG TARGETARCH
RUN set -e; \
    case "$TARGETARCH" in amd64 | "") arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac; \
    file="uv-$arch-unknown-linux-gnu.tar.gz"; \
    base="https://github.com/astral-sh/uv/releases/download/$UV_VERSION"; \
    cd /tmp && curl -fsSLO "$base/$file" && curl -fsSL "$base/$file.sha256" | sha256sum -c - \
    && tar -xzf "$file" -C /usr/local/bin --strip-components 1 \
       "uv-$arch-unknown-linux-gnu/uv" "uv-$arch-unknown-linux-gnu/uvx" \
    && rm "$file" && uv --version

# Provider CLIs, installed globally under /usr/local, outside $HOME: a home
# volume (as in the README's StatefulSet) would hide anything installed
# there. Log in from t3 once the pod is up; the login lives in $HOME, so it
# survives restarts.
RUN npm install -g @anthropic-ai/claude-code && claude --version
# RUN npm install -g @openai/codex && codex --version

USER t3
