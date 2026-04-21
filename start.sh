#!/bin/sh
# Replace PORT placeholder with Railway's dynamic $PORT (nginx public port)
sed -i "s/RAILWAY_PORT/${PORT:-8080}/g" /etc/nginx/nginx.conf

# Start the tools server on a fixed internal port (never PORT, to avoid nginx collision)
cd /srv/transcriber && TOOLS_PORT=3007 node server.js &

# Give it a moment to bind
sleep 2

# Start nginx in foreground
exec nginx -g "daemon off;"
