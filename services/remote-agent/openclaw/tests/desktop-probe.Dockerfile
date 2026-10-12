# Test-only layer over the unmodified, pinned native build stage.
# The native proof exercises a private Linux desktop without a model, host
# screen, task-directory bind mount, public port, or Docker socket.
ARG SOURCE_IMAGE
FROM ${SOURCE_IMAGE}
USER root
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-tools xfce4-session xfce4-panel xfwm4 \
    dbus-daemon dbus-x11 mousepad fonts-noto-cjk fonts-noto-color-emoji \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /proof /app/.artifacts && chown node:node /proof \
    && chown -R node:node /app/.artifacts
# The native proof verifies typed text through AT-SPI, not screenshots alone.
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends at-spi2-core \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY bootstrap-native-proof.mjs /proof-bootstrap.mjs
RUN node /proof-bootstrap.mjs
USER node
WORKDIR /app
ENTRYPOINT ["node", "--import", "./scripts/tsx.mjs", "scripts/dev/selfme-gateway-desktop-proof.ts"]
CMD ["--artifacts", "/proof"]
