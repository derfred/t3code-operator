# The t3 server the end-to-end test runs against by default: T3 Code from
# npm. Pass --t3-image to test another build instead.
FROM node:24-bookworm
ARG T3_VERSION=latest
RUN npm install -g "t3@${T3_VERSION}"
USER node
WORKDIR /home/node
