ARG SOURCE_IMAGE=selfme-lab/openclaw:2026.9.9-source-bcfc88812a35
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
WORKDIR /panel-source/xfce4-panel-4.18.2
RUN ./configure --prefix=/usr --libdir=/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH) --disable-debug --disable-gtk-doc --disable-introspection --disable-vala \
    && make -j2 && make DESTDIR=/panel-root install

FROM panel-build AS terminal-build
# Same native terminal release as Debian; suppress initial focus only for the
# automatic observer marker. Manual launches and later clicks remain unchanged.
RUN apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends libvte-2.91-dev
WORKDIR /terminal-source
RUN curl --fail --location --retry 2 --max-time 120 https://archive.xfce.org/src/apps/xfce4-terminal/1.0/xfce4-terminal-1.0.4.tar.bz2 -o terminal.tar.bz2 \
    && echo '78e55957af7c6fc1f283e90be33988661593a4da98383da1b0b54fdf6554baf4  terminal.tar.bz2' | sha256sum -c - \
    && tar -xjf terminal.tar.bz2
COPY desktop/terminal-focus.mjs /terminal-source/terminal-focus.mjs
RUN node terminal-focus.mjs /terminal-source/xfce4-terminal-1.0.4
WORKDIR /terminal-source/xfce4-terminal-1.0.4
RUN ./configure --prefix=/usr --disable-debug \
    && make -j2 && make DESTDIR=/terminal-root install

FROM ${SOURCE_IMAGE}
USER root
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
# Curated desktop shell; task and provider state stays in its native volume.
RUN sed -i 's|URIs: http://deb.debian.org/|URIs: https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends xfdesktop4 thunar desktop-base librsvg2-common xfce4-terminal tmux wmctrl xdotool \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY plugin /opt/selfme/plugin
COPY --from=model-discovery /provider-models.ts /opt/selfme/plugin/provider-models.ts
COPY --from=model-discovery /terminal-response.ts /opt/selfme/plugin/terminal-response.ts
COPY bootstrap /opt/selfme/bootstrap
COPY desktop /opt/selfme/desktop
COPY --from=panel-build /panel-root/usr/bin/xfce4-panel /usr/bin/xfce4-panel
COPY --from=panel-build /panel-root/usr/lib/ /usr/lib/
COPY --from=panel-build /panel-source/xfce4-panel-4.18.2/COPYING /opt/selfme/desktop/LICENSE.xfce4-panel
COPY --from=terminal-build /terminal-root/usr/bin/xfce4-terminal /usr/bin/xfce4-terminal
COPY --from=terminal-build /terminal-source/xfce4-terminal-1.0.4/COPYING /opt/selfme/desktop/LICENSE.xfce4-terminal
RUN chown -R node:node /opt/selfme
USER node
