#!/bin/sh
# Download a verified release when one exists, then install only its result.
set -eu

die() { echo "kazuki install: $*" >&2; exit 1; }
valid_tag() { printf '%s\n' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/kazuki.XXXXXX") || die "could not make temporary directory"
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

repo=https://github.com/lovexbytes/kazuki
latest=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$repo/releases/latest") || die "could not find the latest release"
case "$latest" in
  "$repo/releases") release= ;;
  "$repo/releases/tag/"*)
    tag=${latest##*/}
    valid_tag "$tag" || die "unexpected release version"
    release=$tag
    ;;
  *) die "unexpected latest-release destination: $latest" ;;
esac

if [ -n "$release" ]; then
  archive="kazuki-$platform-$arch.tar.gz"
  base="$repo/releases/download/$release"
  sums="$tmp/SHA256SUMS"
  tarball="$tmp/$archive"
  curl -fLsS -o "$sums" "$base/SHA256SUMS" || die "could not download checksums"
  sum=$(grep -E "^[0-9a-fA-F]{64}  $archive$" "$sums" || true)
  [ "$(printf '%s\n' "$sum" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] || die "expected one checksum for $archive"
  expected=${sum%% *}
  curl -fLsS -o "$tarball" "$base/$archive" || die "could not download $archive"
  if [ "$platform" = darwin ]; then got=$(shasum -a 256 "$tarball"); else got=$(sha256sum "$tarball"); fi
  [ "${got%% *}" = "$expected" ] || die "$archive checksum did not match"
  extract="$tmp/extract"
  mkdir "$extract" || die "could not make extraction directory"
  tar -xzf "$tarball" -C "$extract" || die "could not extract $archive"
  out="$extract/kazuki"
  [ -f "$out" ] && [ ! -L "$out" ] && [ -x "$out" ] || die "$archive was incomplete"
else
  # Ponytail: source fallback lasts only until the first verified release.
  case "$platform-$arch" in
    darwin-aarch64) sum=80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403 ;;
    darwin-x64-baseline) sum=0fde04e8b092156b97fe6432e899baf16d9ed6ce52cbb4218d2d9c07a2f827ef ;;
    linux-aarch64) sum=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21 ;;
    linux-x64-baseline) sum=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b ;;
  esac
  bun_archive="bun-$platform-$arch.zip"
  zip="$tmp/$bun_archive"
  curl -fLsS -o "$zip" "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/$bun_archive" || die "could not download Bun"
  if [ "$platform" = darwin ]; then got=$(shasum -a 256 "$zip"); else got=$(sha256sum "$zip"); fi
  [ "${got%% *}" = "$sum" ] || die "Bun checksum did not match"
  unzip -q "$zip" -d "$tmp" || die "could not extract Bun"
  bun="$tmp/bun-$platform-$arch/bun"
  [ -x "$bun" ] || die "Bun archive was incomplete"
  src="$tmp/source"
  mkdir "$src" || die "could not make source directory"
  curl -fLsS -o "$tmp/source.tar.gz" https://codeload.github.com/lovexbytes/kazuki/tar.gz/refs/heads/main || die "could not download source"
  tar -xzf "$tmp/source.tar.gz" --strip-components=1 -C "$src" || die "could not extract source"
  [ -f "$src/Term.ts" ] && [ -f "$src/web/app.js" ] || die "source archive was incomplete"
  out="$tmp/kazuki"
  "$bun" build --compile "$src/Term.ts" --outfile "$out" || die "could not compile kazuki"
  [ -f "$out" ] || die "compile produced no executable"
fi

bin="$HOME/.local/bin"
target="$bin/kazuki"
[ ! -L "$target" ] || die "$target is a symlink"
[ ! -e "$target" ] || [ -f "$target" ] || die "$target is not a regular file"
mkdir -p "$bin" || die "could not create $bin"
stage=$(mktemp "$bin/.kazuki.XXXXXX") || die "could not prepare installation"
chmod 755 "$out" || die "could not prepare executable"
mv "$out" "$stage" || die "could not stage executable"
mv -f "$stage" "$target" || die "could not install $target"
stage=
echo "Installed kazuki at $target"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to PATH to run kazuki." ;; esac
