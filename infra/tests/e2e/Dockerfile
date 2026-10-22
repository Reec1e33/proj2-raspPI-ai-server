# Debian with systemd as PID 1, close to a fresh Raspberry Pi OS Lite image.
# Used by tests/e2e.sh only.
ARG CODENAME=bookworm
FROM debian:${CODENAME}
ENV container=docker
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       systemd systemd-sysv dbus systemd-timesyncd sudo iproute2 procps ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash -G sudo reece
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
