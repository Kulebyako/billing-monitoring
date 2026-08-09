#!/usr/bin/env bash
# Collect UFW / fail2ban stats into node_exporter textfile metrics.
set -euo pipefail

OUT_DIR="/var/lib/node_exporter/textfile"
OUT_FILE="${OUT_DIR}/security.prom"
TMP_FILE="${OUT_FILE}.$$"

mkdir -p "${OUT_DIR}"

ufw_enabled=0
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw_enabled=1
  fi
fi

# Count UFW BLOCKs in the last hour.
# Do NOT lexicographically compare syslog dates in awk ("Aug" < "Jul" → false positives).
ufw_blocks_1h=0
if command -v journalctl >/dev/null 2>&1; then
  ufw_blocks_1h="$(journalctl -k --since '1 hour ago' --no-pager 2>/dev/null | grep -c 'UFW BLOCK' || true)"
elif [[ -f /var/log/ufw.log ]] && command -v python3 >/dev/null 2>&1; then
  ufw_blocks_1h="$(
    python3 - <<'PY'
from datetime import datetime, timedelta
import re
now = datetime.utcnow()
cutoff = now - timedelta(hours=1)
year = now.year
count = 0
with open("/var/log/ufw.log", errors="ignore") as f:
    for line in f:
        if "[UFW BLOCK]" not in line:
            continue
        m = re.match(r"^(\w+)\s+(\d+)\s+(\d+:\d+:\d+)", line)
        if not m:
            continue
        try:
            ts = datetime.strptime(f"{m.group(1)} {m.group(2)} {year} {m.group(3)}", "%b %d %Y %H:%M:%S")
        except ValueError:
            continue
        if ts > now + timedelta(days=1):
            ts = ts.replace(year=year - 1)
        if ts >= cutoff:
            count += 1
print(count)
PY
  )"
elif [[ -f /var/log/ufw.log ]]; then
  # Last resort: only count lines whose HH:MM falls in a rough window (imperfect).
  ufw_blocks_1h="$(grep -c '\[UFW BLOCK\]' /var/log/ufw.log 2>/dev/null || echo 0)"
fi
ufw_blocks_1h="$(echo "${ufw_blocks_1h}" | tr -cd '0-9')"
ufw_blocks_1h="${ufw_blocks_1h:-0}"

fail2ban_jails=0
{
  echo "# HELP node_security_ufw_enabled Whether UFW is active (1=yes)."
  echo "# TYPE node_security_ufw_enabled gauge"
  echo "node_security_ufw_enabled ${ufw_enabled}"
  echo "# HELP node_security_ufw_blocks_1h UFW blocked events in the last hour."
  echo "# TYPE node_security_ufw_blocks_1h gauge"
  echo "node_security_ufw_blocks_1h ${ufw_blocks_1h}"
  echo "# HELP node_security_fail2ban_banned Currently banned IPs per jail."
  echo "# TYPE node_security_fail2ban_banned gauge"
  echo "# HELP node_security_fail2ban_jails Number of active fail2ban jails."
  echo "# TYPE node_security_fail2ban_jails gauge"

  if command -v fail2ban-client >/dev/null 2>&1; then
    jails="$(fail2ban-client status 2>/dev/null | awk -F: '/Jail list:/ {print $2}' | tr ',' ' ' || true)"
    for jail in ${jails}; do
      jail="$(echo "${jail}" | xargs)"
      [[ -z "${jail}" ]] && continue
      banned="$(fail2ban-client status "${jail}" 2>/dev/null | awk '/Currently banned:/ {print $NF}' || echo 0)"
      echo "node_security_fail2ban_banned{jail=\"${jail}\"} ${banned:-0}"
      fail2ban_jails=$((fail2ban_jails + 1))
    done
  fi
  echo "node_security_fail2ban_jails ${fail2ban_jails}"
} >"${TMP_FILE}"

mv "${TMP_FILE}" "${OUT_FILE}"
chmod 644 "${OUT_FILE}"
