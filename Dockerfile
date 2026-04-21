FROM node:18-alpine

# Install nginx, remove default conflicting configs
RUN apk add --no-cache nginx \
    && rm -f /etc/nginx/http.d/default.conf \
    && rm -f /etc/nginx/conf.d/default.conf

# ── Install tools server dependencies ────────────────────────
WORKDIR /srv/transcriber
COPY transcriber/package*.json ./
RUN npm ci --omit=dev
COPY transcriber/ ./

# ── Copy static files for nginx ───────────────────────────────
RUN mkdir -p /usr/share/nginx/html
COPY . /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/nginx.conf

# Run everything inline — no shell script, no CRLF issues
CMD sh -c '\
  sed -i "s/RAILWAY_PORT/${PORT:-8080}/g" /etc/nginx/nginx.conf && \
  echo "Starting tools server on port 3007..." && \
  cd /srv/transcriber && TOOLS_PORT=3007 node server.js & \
  echo "Waiting for tools server..." && \
  sleep 4 && \
  echo "Starting nginx on port ${PORT:-8080}..." && \
  nginx -g "daemon off;" \
'
