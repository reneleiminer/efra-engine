#!/bin/sh
set -eu
umask 077
# This is a one-shot initializer on new named volumes, without a network.
for path in /canonical /vault /control /inbox /outbox /trust /keys /leases; do
  test -z "$(ls -A "$path")" || { echo "Pilot fixture volumes must be empty"; exit 1; }
done
temp=$(mktemp -d)
trap 'rm -f "$temp/ca.key" "$temp/ca.crt" "$temp/ca.srl" "$temp/server.csr" "$temp/server.ext"; rmdir "$temp"' EXIT
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 2 -subj '/CN=EFRA Synthetic Local CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$temp/ca.key" -out "$temp/ca.crt" >/dev/null 2>&1
for service in canonical vault; do
  dir="/$service"
  openssl rand -hex 32 > "$dir/password"
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$service" -keyout "$dir/server.key" \
    -out "$temp/server.csr" >/dev/null 2>&1
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$service" > "$temp/server.ext"
  openssl x509 -req -in "$temp/server.csr" -CA "$temp/ca.crt" -CAkey "$temp/ca.key" -CAcreateserial \
    -days 2 -sha256 -extfile "$temp/server.ext" -out "$dir/server.crt" >/dev/null 2>&1
  printf '%s\n' 'local all all trust' 'hostssl all all all scram-sha-256' 'hostnossl all all all reject' > "$dir/pg_hba.conf"
  cp "$dir/password" "/control/$service.password"
  chown -R postgres:postgres "$dir"
  chmod 700 "$dir"
done
cp "$temp/ca.crt" /control/ca.crt
chown -R 1000:1000 /control /inbox /outbox /trust /keys /leases
chmod 700 /control /inbox /outbox /trust /keys /leases
printf '%s\n' '{"event":"LOCAL_TEST_PKI_READY","scope":"SYNTHETIC_ONLY"}'
