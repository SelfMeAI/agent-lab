ARG SOURCE_IMAGE=selfme-lab/openclaw:2026.9.9-source-bcfc88812a35
FROM ${SOURCE_IMAGE}
USER root
# Restore the standard Xfce desktop, including Debian's default wallpaper and
# the file manager used by its native desktop icons. No custom backdrop/config.
RUN sed -i 's|URIs: http://deb.debian.org/|URIs: https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends xfdesktop4 thunar desktop-base librsvg2-common \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY plugin /opt/selfme/plugin
COPY --from=model-discovery /provider-models.ts /opt/selfme/plugin/provider-models.ts
COPY bootstrap /opt/selfme/bootstrap
RUN chown -R node:node /opt/selfme
USER node
