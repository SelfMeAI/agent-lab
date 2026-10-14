FROM scratch
ARG REPOSITORY
ARG UNLINK_NONCE
LABEL org.opencontainers.image.source="${REPOSITORY}"
LABEL ai.agent-lab.maintenance="tag-unlink"
LABEL ai.agent-lab.unlink.nonce="${UNLINK_NONCE}"
