#!/bin/sh
# Polaris for Business: the image's entrypoint.
#
# Fly and Railway mount a volume over /data owned by root, which the server
# (running as the unprivileged `node` user) couldn't write. Started as root,
# this makes the data directory node's and then runs the server as node;
# started as any other user (docker run --user), it just runs the server.
set -eu

DATA_DIR="${POLARIS_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only when something in it isn't node's already: a large store isn't walked on every boot.
  if [ -n "$(find "$DATA_DIR" ! -user node -print -quit)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
