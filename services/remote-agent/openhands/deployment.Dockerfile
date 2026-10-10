ARG SOURCE_IMAGE=selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86
FROM ${SOURCE_IMAGE}
USER root
RUN sed -i 's|http://snapshot.debian.org|https://snapshot.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends xvfb x11vnc fonts-noto-cjk \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY extension /opt/selfme
USER openhands
ENTRYPOINT ["tini", "--", "/agent-server/.venv/bin/python", "/opt/selfme/app.py"]
