# nginx in front of the app, with its config built in rather than mounted from the checkout: the updater container
# (deploy/updater.sh) runs docker compose from inside a container, where the checkout's path on the host is unknown.
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY 40-resolver.sh /docker-entrypoint.d/40-resolver.sh
