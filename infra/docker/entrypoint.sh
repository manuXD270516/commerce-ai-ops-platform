#!/bin/sh
# Exports every FOO_FILE variable as FOO with the content of that file, so secrets arrive as
# mounted files (Docker/Compose secrets) instead of plain environment values or image layers.
set -eu
# AUTH_JWKS_FILE and AUTH_SIGNING_KEY_FILE are paths the apps read themselves; they stay as paths.
for var in $(env | sed -n 's/^\([A-Z0-9_]*\)_FILE=.*/\1/p' | grep -v -e '^AUTH_JWKS$' -e '^AUTH_SIGNING_KEY$'); do
  file=$(printenv "${var}_FILE")
  if [ -r "$file" ]; then
    export "$var=$(cat "$file")"
  else
    echo "entrypoint: ${var}_FILE points to unreadable $file" >&2
    exit 1
  fi
done
# Platforms that inject secrets as environment values (ECS + Secrets Manager) pass the key material
# itself in AUTH_JWKS / AUTH_SIGNING_KEY: write it to a private tmpfs-style file the apps can read.
umask 077
for var in AUTH_JWKS AUTH_SIGNING_KEY; do
  value=$(printenv "$var" || true)
  if [ -n "$value" ]; then
    file="/tmp/$(echo "$var" | tr 'A-Z_' 'a-z-').json"
    printf '%s' "$value" > "$file"
    export "${var}_FILE=$file"
    unset "$var"
  fi
done
exec "$@"
