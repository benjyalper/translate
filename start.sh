#!/bin/sh
# Replace PORT placeholder in nginx config with Railway's dynamic $PORT
sed -i "s/RAILWAY_PORT/${PORT:-8080}/g" /etc/nginx/nginx.conf
nginx -g "daemon off;"
