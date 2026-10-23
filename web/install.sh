#!/bin/sh
# Download Bun briefly, compile this source tree, and install only the result.
set -eu

die() { echo "unii install: $*" >&2; exit 1; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/unii.XXXXXX") || die "could not make temporary directory"
stage=
trap 'rm -rf "$tmp"; [ -z "$stage" ] || rm -f "$stage"' EXIT HUP INT TERM

case $(uname -s) in
  Darwin) platform=darwin ;;
  Linux)  platform=linux ;;
  *) die "unsupported operating system: $(uname -s)" ;;
esac
case $(uname -m) in
  arm64|aarch64) arch=aarch64 ;;
  x86_64) arch=x64-baseline ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

case "$platform-$arch" in
  darwin-aarch64) sum=80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403 ;;
  darwin-x64-baseline) sum=0fde04e8b092156b97fe6432e899baf16d9ed6ce52cbb4218d2d9c07a2f827ef ;;
  linux-aarch64) sum=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21 ;;
  linux-x64-baseline) sum=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b ;;
esac

archive="bun-$platform-$arch.zip"
zip="$tmp/$archive"
curl -fLsS -o "$zip" "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/$archive" || die "could not download Bun"
if [ "$platform" = darwin ]; then
  got=$(shasum -a 256 "$zip") || die "could not checksum Bun"
else
  got=$(sha256sum "$zip") || die "could not checksum Bun"
fi
[ "${got%% *}" = "$sum" ] || die "Bun checksum did not match"
unzip -q "$zip" -d "$tmp" || die "could not extract Bun"
bun="$tmp/bun-$platform-$arch/bun"
[ -x "$bun" ] || die "Bun archive was incomplete"

src="$tmp/source"
mkdir "$src" || die "could not make source directory"
curl -fLsS -o "$tmp/source.tar.gz" https://codeload.github.com/lovexbytes/uniichat/tar.gz/refs/heads/main || die "could not download source"
tar -xzf "$tmp/source.tar.gz" --strip-components=1 -C "$src" || die "could not extract source"
[ -f "$src/Term.ts" ] && [ -f "$src/web/app.js" ] || die "source archive was incomplete"
out="$tmp/unii"
"$bun" build --compile "$src/Term.ts" --outfile "$out" || die "could not compile unii"
[ -f "$out" ] || die "compile produced no executable"

bin="$HOME/.local/bin"
target="$bin/unii"
[ ! -L "$target" ] || die "$target is a symlink"
[ ! -e "$target" ] || [ -f "$target" ] || die "$target is not a regular file"
mkdir -p "$bin" || die "could not create $bin"
stage=$(mktemp "$bin/.unii.XXXXXX") || die "could not prepare installation"
chmod 755 "$out" || die "could not prepare executable"
mv "$out" "$stage" || die "could not stage executable"
mv -f "$stage" "$target" || die "could not install $target"
stage=
echo "Installed unii at $target"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to PATH to run unii." ;; esac
