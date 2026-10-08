# The updater (deploy/updater.sh): docker compose, git and what the script needs. It runs the script from the
# checkout mounted at /repo, so it uses the version it last pulled. Started with: docker compose --profile updater up -d
FROM docker:28-cli
RUN apk add --no-cache bash curl git jq su-exec && git config --system --add safe.directory '*'
ENTRYPOINT ["bash", "/repo/deploy/updater.sh"]
