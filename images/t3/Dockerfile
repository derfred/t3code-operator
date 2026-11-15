# A minimal t3 server image for the operator to manage: t3 built from the
# derfred/t3code fork, whose `t3 serve --auth-token-file` (or
# T3CODE_AUTH_TOKEN_FILE) accepts a bearer token you choose. See README.md,
# Tokens, the first way.
#
#   docker build -t t3 images/t3
#   docker build -t t3 --build-arg T3_REF=<commit> images/t3      # pin a commit
#
# Minimal: t3 and what it needs to clone and work on repositories (git, ssh),
# nothing an agent might want on top. The t3 executable embeds its Node, so
# the image has none; build FROM it to add tools.

FROM node:24-bookworm AS build
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

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client procps \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /usr/local/lib/t3
# A wrapper, not a symlink: t3 finds client/ and its node_modules next to
# the executable it was started as.
RUN printf '#!/bin/sh\nexec /usr/local/lib/t3/t3 "$@"\n' > /usr/local/bin/t3 \
  && chmod 0755 /usr/local/bin/t3 && t3 --version

# uid/gid 1000, as the README's StatefulSet runs it (runAsUser, fsGroup),
# with its home where that StatefulSet mounts t3's data.
RUN groupadd --gid 1000 t3 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/node t3 \
  && mkdir /workspace && chown t3:t3 /workspace
ENV HOME=/home/node
WORKDIR /workspace
USER t3
EXPOSE 3773

# On all addresses, so the operator reaches it on the pod's IP. Set
# T3CODE_AUTH_TOKEN_FILE to the token file's path.
CMD ["t3", "serve", "--host", "0.0.0.0", "--port", "3773"]
