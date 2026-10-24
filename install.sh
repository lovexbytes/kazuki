#!/bin/sh
# Download the latest release, verify its checksum, then install only its result.
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
  "$repo/releases/tag/"*) release=${latest##*/} ;;
  *) die "no published release found (got $latest)" ;;
esac
valid_tag "$release" || die "unexpected release version"

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
