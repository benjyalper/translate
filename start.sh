#!/bin/sh
# Replace PORT placeholder with Railway's dynamic $PORT
sed -i "s/RAILWAY_PORT/${PORT:-8080}/g" /etc/nginx/nginx.conf

# Start the tools server (Transcriber + Trados + Scraper APIs)
cd /srv/transcriber && node server.js &

# Give it a moment to bind
sleep 2

# Start nginx in foreground
exec nginx -g "daemon off;"
