#!/usr/bin/env bash
# Install lightweight node_exporter on a remote VPS (systemd).
# Usage: sudo ./install-node-exporter.sh
set -euo pipefail

VERSION="${NODE_EXPORTER_VERSION:-1.9.0}"
ARCH="${ARCH:-linux-amd64}"
INSTALL_DIR="/usr/local/bin"
USER="node-exp"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

id -u "${USER}" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "${USER}"

TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

URL="https://github.com/prometheus/node_exporter/releases/download/v${VERSION}/node_exporter-${VERSION}.${ARCH}.tar.gz"
curl -fsSL "${URL}" -o "${TMP}/node_exporter.tar.gz"
tar -xzf "${TMP}/node_exporter.tar.gz" -C "${TMP}"
install -m 0755 "${TMP}/node_exporter-${VERSION}.${ARCH}/node_exporter" "${INSTALL_DIR}/node_exporter"

cat >/etc/systemd/system/node_exporter.service <<'UNIT'
[Unit]
Description=Prometheus Node Exporter (lightweight)
After=network-online.target
Wants=network-online.target

[Service]
User=node-exp
Group=node-exp
Type=simple
ExecStart=/usr/local/bin/node_exporter \
  --web.listen-address=:9100 \
  --collector.disable-defaults \
  --collector.cpu \
  --collector.meminfo \
  --collector.diskstats \
  --collector.filesystem \
  --collector.netdev \
  --collector.loadavg \
  --collector.uname \
  --collector.textfile \
  --collector.textfile.directory=/var/lib/node_exporter/textfile
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now node_exporter
systemctl status node_exporter --no-pager

echo ""
echo "node_exporter listening on :9100"
echo "Allow scrape only from your monitoring VPS IP, e.g.:"
echo "  ufw allow from MONITORING_IP to any port 9100 proto tcp"
