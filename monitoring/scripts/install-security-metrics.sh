#!/usr/bin/env bash
# Enable security textfile metrics for node_exporter (UFW + fail2ban).
# Usage: sudo ./install-security-metrics.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/collect-security-metrics.sh"
INSTALL_DIR="/usr/local/bin"
TEXTFILE_DIR="/var/lib/node_exporter/textfile"

install -m 0755 "${SCRIPT_SRC}" "${INSTALL_DIR}/collect-security-metrics.sh"
mkdir -p "${TEXTFILE_DIR}"
chown node-exp:node-exp "${TEXTFILE_DIR}" 2>/dev/null || chown root:root "${TEXTFILE_DIR}"

if [[ -f /etc/systemd/system/node_exporter.service ]]; then
  FIX_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fix-node-exporter-textfile.sh"
  if [[ -f "${FIX_SCRIPT}" ]]; then
    bash "${FIX_SCRIPT}"
  fi
fi

cat >/etc/systemd/system/security-metrics.service <<UNIT
[Unit]
Description=Collect security metrics for node_exporter
After=network-online.target

[Service]
Type=oneshot
ExecStart=${INSTALL_DIR}/collect-security-metrics.sh
UNIT

cat >/etc/systemd/system/security-metrics.timer <<UNIT
[Unit]
Description=Run security metrics collector every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now security-metrics.timer
"${INSTALL_DIR}/collect-security-metrics.sh"

if systemctl is-active --quiet node_exporter; then
  systemctl restart node_exporter
fi

echo "Security metrics enabled:"
echo "  textfile: ${TEXTFILE_DIR}/security.prom"
systemctl status security-metrics.timer --no-pager | sed -n '1,5p'
