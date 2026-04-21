FROM node:18-alpine

# Install nginx
RUN apk add --no-cache nginx

# ── Install tools server dependencies ────────────────────────
WORKDIR /srv/transcriber
COPY transcriber/package*.json ./
RUN npm ci --omit=dev
COPY transcriber/ ./

# ── Copy static files for nginx ───────────────────────────────
RUN mkdir -p /usr/share/nginx/html
COPY . /usr/share/nginx/html/

COPY nginx.conf /etc/nginx/nginx.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
