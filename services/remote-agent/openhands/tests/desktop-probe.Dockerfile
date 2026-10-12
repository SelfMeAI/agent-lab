# A deployment-side display/observer proof, not a fork of the native agent loop.
ARG SOURCE_IMAGE
FROM ${SOURCE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc python3-websockify fonts-noto-cjk fonts-noto-color-emoji \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY desktop_fixture.py /proof-code/desktop_fixture.py
USER openhands
ENV PYTHONPATH=/proof-code SELFME_DESKTOP_PROBE=1
