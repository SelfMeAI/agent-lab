ARG SOURCE_IMAGE=agent-lab/openclaw:2026.9.9-source-bcfc88812a35
FROM ${SOURCE_IMAGE} AS panel-build
USER root
# Pinned upstream desktop component; no fork of the agent/harness.
RUN sed -i 's|URIs: http://deb.debian.org/|URIs: https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends build-essential pkg-config curl ca-certificates intltool gettext libexo-2-dev libxfce4util-dev libxfce4ui-2-dev libxfconf-0-dev libgarcon-1-0-dev libgarcon-gtk3-1-dev libgtk-3-dev libwnck-3-dev libstartup-notification0-dev libdbus-glib-1-dev libx11-dev libxrandr-dev libxext-dev libxfixes-dev
WORKDIR /panel-source
RUN curl --fail --location --retry 2 --max-time 120 https://archive.xfce.org/src/xfce/xfce4-panel/4.18/xfce4-panel-4.18.2.tar.bz2 -o panel.tar.bz2 \
    && echo '7c6c9c38da9f8bdedad7cd64217e42a7ba40e7e3502513c23f121b8038e57dc1  panel.tar.bz2' | sha256sum -c - \
    && tar -xjf panel.tar.bz2
COPY desktop/panel-menu.mjs /panel-source/panel-menu.mjs
RUN node panel-menu.mjs /panel-source/xfce4-panel-4.18.2
# Preserve the exact modified source before compilation, with its license and
# the recipe/patch. Binary image recipients can extract these without Git.
RUN mkdir /panel-distribution \
    && tar -cjf /panel-distribution/xfce4-panel-4.18.2-agent-lab.tar.bz2 -C /panel-source xfce4-panel-4.18.2
COPY deployment.Dockerfile /panel-distribution/deployment.Dockerfile
COPY desktop/panel-menu.mjs /panel-distribution/panel-menu.mjs
WORKDIR /panel-source/xfce4-panel-4.18.2
RUN ./configure --prefix=/usr --libdir=/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH) --disable-debug --disable-gtk-doc --disable-introspection --disable-vala \
    && make -j2 && make DESTDIR=/panel-root install

FROM ${SOURCE_IMAGE}
USER root
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    XDG_DATA_HOME=/home/node/.openclaw/.agent-lab-desktop/data
# Curated desktop shell; task and provider state stays in its native volume.
RUN sed -i 's|URIs: http://deb.debian.org/|URIs: https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends xfdesktop4 thunar desktop-base librsvg2-common xfce4-terminal tmux wmctrl xdotool fonts-noto-color-emoji gvfs libglib2.0-bin xdg-user-dirs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY plugin /opt/agent-lab/plugin
COPY --from=model-discovery /provider-models.ts /opt/agent-lab/plugin/provider-models.ts
COPY --from=model-discovery /identity.ts /opt/agent-lab/plugin/identity.ts
COPY --from=model-discovery /terminal-response.ts /opt/agent-lab/plugin/terminal-response.ts
COPY --from=model-discovery /openclaw/connection.ts /opt/agent-lab/plugin/native/openclaw/connection.ts
COPY --from=model-discovery /openclaw/gateway.ts /opt/agent-lab/plugin/native/openclaw/gateway.ts
COPY --from=model-discovery /transport/endpoint.ts /opt/agent-lab/plugin/native/transport/endpoint.ts
COPY bootstrap /opt/agent-lab/bootstrap
COPY --from=document-preview /office-preview.mjs /opt/document-preview/office-preview.mjs
COPY desktop /opt/agent-lab/desktop
COPY --from=project-licenses /LICENSE /NOTICE /THIRD_PARTY_NOTICES.txt /opt/agent-lab/licenses/
COPY --from=panel-build /panel-distribution /opt/agent-lab/desktop/sources
COPY --from=panel-build /panel-root/usr/bin/xfce4-panel /usr/bin/xfce4-panel
COPY --from=panel-build /panel-root/usr/lib/ /usr/lib/
COPY --from=panel-build /panel-source/xfce4-panel-4.18.2/COPYING /opt/agent-lab/desktop/LICENSE.xfce4-panel
RUN chown -R node:node /opt/agent-lab
USER node
