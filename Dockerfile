FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf
COPY . /usr/share/nginx/html
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
