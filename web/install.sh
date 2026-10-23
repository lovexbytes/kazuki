#!/bin/sh
# Keep the original published installer URL forwarding to the canonical one.
set -eu
tmp=$(mktemp -d "${TMPDIR:-/tmp}/unii.XXXXXX") || { echo "unii install: could not make temporary directory" >&2; exit 1; }
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
script="$tmp/install.sh"
curl -fLsS -o "$script" https://raw.githubusercontent.com/lovexbytes/uniichat/main/install.sh
sh "$script"
