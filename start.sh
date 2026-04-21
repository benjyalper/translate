#!/bin/sh
set -e

# Patch nginx config with Railway's dynamic PORT
sed -i "s/RAILWAY_PORT/${PORT:-8080}/g" /etc/nginx/nginx.conf

# Start the tools server on fixed internal port 3007
echo "Starting tools server on port 3007..."
cd /srv/transcriber && TOOLS_PORT=3007 node server.js &
NODE_PID=$!

# Wait until the tools server is accepting connections (max 15s)
echo "Waiting for tools server to be ready..."
i=0
while [ $i -lt 15 ]; do
  if wget -q -O- http://127.0.0.1:3007/api/status > /dev/null 2>&1; then
    echo "Tools server is ready."
    break
  fi
  sleep 1
  i=$((i+1))
done

if [ $i -eq 15 ]; then
  echo "WARNING: Tools server did not start in time — nginx will start anyway."
fi

# Start nginx in foreground
echo "Starting nginx on port ${PORT:-8080}..."
exec nginx -g "daemon off;"
