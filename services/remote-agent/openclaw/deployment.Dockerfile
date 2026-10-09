ARG SOURCE_IMAGE=selfme-lab/openclaw:2026.9.9-source-bcfc88812a35
FROM ${SOURCE_IMAGE}
USER root
COPY plugin /opt/selfme/plugin
RUN chown -R node:node /opt/selfme
USER node
