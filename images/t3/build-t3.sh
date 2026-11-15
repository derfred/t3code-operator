#!/usr/bin/env bash
# Builds t3 from a t3code git checkout into the self-contained tree an
# upstream release ships (t3-<version>-linux-<arch>.tar.gz: the t3 executable
# with Node embedded, client/, resource-monitor/, the native node_modules),
# following upstream's release workflow. Runs in the Dockerfile's build stage.
#
#   build-t3.sh REPO_URL REF ARCH OUT_DIR
#
# REF is a branch, tag or commit; ARCH is x64 or arm64. OUT_DIR gets the
# extracted tree plus REVISION, the commit it was built from.
set -euo pipefail

repo=$1 ref=$2 arch=$3 out=$4
src=/src

case "$arch" in
  x64 | arm64) ;;
  *) echo "build-t3.sh: unsupported arch $arch (x64 or arm64)" >&2; exit 2 ;;
esac

# patchelf and libatomic1: the Linux archive carries its own libatomic.so.1
# and points t3's RUNPATH at it. xz-utils: the Node tarball.
apt-get update
apt-get install -y --no-install-recommends patchelf libatomic1 xz-utils
rm -rf /var/lib/apt/lists/*

git init -q "$src"
git -C "$src" fetch -q --depth 1 "$repo" "$ref"
git -C "$src" checkout -q FETCH_HEAD
cd "$src"
commit=$(git rev-parse HEAD)
echo "building t3 from $repo $ref ($commit) for linux-$arch"

# The executable embeds the Node that builds it, and t3 pins that version
# exactly (engines.node); the build image's own Node only runs npm.
node_version=$(node -p 'require("./package.json").engines.node')
node_dir=/opt/node-$node_version
tarball=node-v$node_version-linux-$arch.tar.xz
curl -fsSLO "https://nodejs.org/dist/v$node_version/$tarball"
curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" | grep " $tarball\$" | sha256sum -c -
mkdir -p "$node_dir"
tar -xJf "$tarball" -C "$node_dir" --strip-components=1
rm "$tarball"
export PATH="$src/node_modules/.bin:$node_dir/bin:$PATH"
node --version

# Rust, for the resource monitor the archive ships.
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs |
  sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
export PATH="$HOME/.cargo/bin:$PATH"

pnpm_version=$(node -p 'require("./package.json").packageManager.split("@")[1]')
npm install -g "pnpm@$pnpm_version"
pnpm install --frozen-lockfile

vp run --filter t3 build
node apps/server/scripts/cli.ts build-exe --verbose
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p "/tmp/resource-monitor/linux-$arch"
cp native/resource-monitor/target/release/t3-resource-monitor "/tmp/resource-monitor/linux-$arch/"

version=$(node -p 'require("./apps/server/package.json").version')
node scripts/build-cli-archive.ts --platform linux --arch "$arch" --version "$version" \
  --resource-monitor-dir /tmp/resource-monitor --output-dir /tmp/release-cli

mkdir -p "$out"
tar -xzf "/tmp/release-cli/t3-$version-linux-$arch.tar.gz" -C "$out" --strip-components=1
echo "$commit" > "$out/REVISION"
"$out/t3" --version
