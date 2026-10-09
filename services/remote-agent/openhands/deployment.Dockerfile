ARG SOURCE_IMAGE=selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86
FROM ${SOURCE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY extension /opt/selfme
USER openhands
ENTRYPOINT ["tini", "--", "/agent-server/.venv/bin/python", "/opt/selfme/app.py"]
