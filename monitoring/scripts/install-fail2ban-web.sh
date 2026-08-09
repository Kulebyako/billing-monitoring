#!/usr/bin/env bash
# Install fail2ban jails for public panel + Grafana (no IP allowlist needed).
# Re-run after `docker compose up` recreates containers (log paths change).
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq fail2ban

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILTER_DIR="$(cd "${SCRIPT_DIR}/../fail2ban" && pwd)"
install -m 0644 "${FILTER_DIR}/filter-server-billing.conf" /etc/fail2ban/filter.d/server-billing.conf
install -m 0644 "${FILTER_DIR}/filter-grafana.conf" /etc/fail2ban/filter.d/grafana-docker.conf

BILLING_CTR="${BILLING_CTR:-server-billing-server-billing-1}"
GRAFANA_CTR="${GRAFANA_CTR:-grafana}"

BILLING_LOG=$(docker inspect --format='{{.LogPath}}' "${BILLING_CTR}" 2>/dev/null || true)
GRAFANA_LOG=$(docker inspect --format='{{.LogPath}}' "${GRAFANA_CTR}" 2>/dev/null || true)

if [[ -z "${BILLING_LOG}" || -z "${GRAFANA_LOG}" ]]; then
  echo "ERROR: need running containers ${BILLING_CTR} and ${GRAFANA_CTR}"
  exit 1
fi

# Docker json logs are often 0640; fail2ban must read them.
chmod 644 "${BILLING_LOG}" "${GRAFANA_LOG}"

# Stable paths — jail config does not break when container IDs change if we re-run this script.
LINK_DIR=/var/log/server-billing-fail2ban
mkdir -p "${LINK_DIR}"
ln -sfn "${BILLING_LOG}" "${LINK_DIR}/server-billing.json.log"
ln -sfn "${GRAFANA_LOG}" "${LINK_DIR}/grafana.json.log"

# Numeric findtime/bantime for fail2ban 0.11 compatibility.
cat >/etc/fail2ban/jail.d/server-billing-web.conf <<EOF
[server-billing]
enabled = true
filter = server-billing
backend = auto
logpath = ${LINK_DIR}/server-billing.json.log
maxretry = 5
findtime = 900
bantime = 3600
port = 3080
action = %(action_)s

[grafana-docker]
enabled = true
filter = grafana-docker
backend = auto
logpath = ${LINK_DIR}/grafana.json.log
maxretry = 5
findtime = 900
bantime = 3600
port = 3000
action = %(action_)s
EOF

fail2ban-client -t
systemctl enable --now fail2ban
systemctl restart fail2ban
sleep 1

fail2ban-client status server-billing
fail2ban-client status grafana-docker

# fail2ban sometimes starts grafana jail without File list until path is re-added
if ! fail2ban-client status grafana-docker | grep -q 'File list:.*grafana'; then
  fail2ban-client set grafana-docker addlogpath "${LINK_DIR}/grafana.json.log" || true
fi

echo "fail2ban ready (re-run this script after docker recreate)"
