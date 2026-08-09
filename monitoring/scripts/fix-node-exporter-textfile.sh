#!/usr/bin/env bash
# Fix node_exporter unit to enable textfile collector.
set -euo pipefail
TEXTFILE_DIR="/var/lib/node_exporter/textfile"
mkdir -p "${TEXTFILE_DIR}"
chown node-exp:node-exp "${TEXTFILE_DIR}" 2>/dev/null || true

cat >/etc/systemd/system/node_exporter.service <<UNIT
[Unit]
Description=Prometheus Node Exporter (lightweight)
After=network-online.target
Wants=network-online.target

[Service]
User=node-exp
Group=node-exp
Type=simple
ExecStart=/usr/local/bin/node_exporter \\
  --web.listen-address=:9100 \\
  --collector.disable-defaults \\
  --collector.cpu \\
  --collector.meminfo \\
  --collector.diskstats \\
  --collector.filesystem \\
  --collector.netdev \\
  --collector.loadavg \\
  --collector.uname \\
  --collector.textfile \\
  --collector.textfile.directory=${TEXTFILE_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl restart node_exporter
systemctl is-active node_exporter
