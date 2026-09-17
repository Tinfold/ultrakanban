#!/bin/sh
# Point nginx at the container DNS server so `app` is re-resolved at request time.
# Without this, nginx caches the address from startup and 502s after the app container restarts.
set -e
nameserver=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)
if [ -n "$nameserver" ]; then
  printf 'resolver %s valid=10s ipv6=off;\n' "$nameserver" > /etc/nginx/conf.d/00-resolver.conf
fi
