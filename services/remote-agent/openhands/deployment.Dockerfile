ARG SOURCE_IMAGE=agent-lab/openhands-agent-server:1.53.0-source-54daf056bd86
FROM ${SOURCE_IMAGE}
USER root
RUN sed -i 's|http://snapshot.debian.org|https://snapshot.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends xvfb x11vnc fonts-noto-cjk fonts-noto-color-emoji \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY extension /opt/agent-lab
RUN chmod 0555 /opt/agent-lab/chromium-task
COPY --from=document-preview /office-preview.mjs /opt/document-preview/office-preview.mjs
COPY --from=document-preview /office-preview-cli.mjs /opt/document-preview/office-preview-cli.mjs
USER openhands
ENTRYPOINT ["tini", "--", "/agent-server/.venv/bin/python", "/opt/agent-lab/app.py"]
