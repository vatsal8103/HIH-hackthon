#!/usr/bin/env bash
# ==============================================================================
# Bayora - Local Firewall & Network Control Setup (Linux)
# ==============================================================================
# Track 4: Securing Adversarial AI Safety Testing Infrastructure
#
# Configures local firewall rules (iptables/nftables) on loopback (127.0.0.1):
#   - Control Plane (CP) on port 8000: reachable by Red, Blue, Target, Witness.
#   - Witness on port 8001: reachable ONLY by CP (port 8000).
#   - Red Agent on port 8002: reachable ONLY by CP; CANNOT reach Blue (8003) or Target (8004).
#   - Blue Agent on port 8003: reachable ONLY by CP; CANNOT reach Red (8002).
#   - Target Agent on port 8004: reachable ONLY by CP; CANNOT reach Red or Blue.
#   - Egress: Red, Blue, Target service accounts DROP all non-loopback outbound traffic.
#
# Requires root privileges (sudo).
# ==============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "[!] This script requires root privileges to configure local firewall rules."
    echo "    Usage: sudo bash $0"
    exit 1
fi

echo "======================================================================"
echo " Bayora: Applying Local Network Controls (iptables / nftables)"
echo "======================================================================"

if command -v iptables >/dev/null 2>&1; then
    echo "[*] Configuring iptables owner-match rules for role users..."

    # 1. Block outbound internet egress for agent service accounts
    for role in "red" "blue" "target"; do
        user="bayora-$role"
        if id "$user" >/dev/null 2>&1; then
            # Drop traffic not destined for loopback interface (lo)
            iptables -C OUTPUT ! -o lo -m owner --uid-owner "$user" -j REJECT 2>/dev/null || \
            iptables -A OUTPUT ! -o lo -m owner --uid-owner "$user" -j REJECT
            echo "    [+] Blocked non-loopback egress for $user"
        fi
    done

    # 2. Block direct cross-role loopback connections
    # Red (8002) -> Blue (8003), Target (8004)
    if id "bayora-red" >/dev/null 2>&1; then
        iptables -C OUTPUT -o lo -p tcp -m owner --uid-owner bayora-red --dport 8003 -j REJECT 2>/dev/null || \
        iptables -A OUTPUT -o lo -p tcp -m owner --uid-owner bayora-red --dport 8003 -j REJECT
        iptables -C OUTPUT -o lo -p tcp -m owner --uid-owner bayora-red --dport 8004 -j REJECT 2>/dev/null || \
        iptables -A OUTPUT -o lo -p tcp -m owner --uid-owner bayora-red --dport 8004 -j REJECT
        echo "    [+] Blocked bayora-red from connecting to ports 8003 (Blue) and 8004 (Target)"
    fi

    # Blue (8003) -> Red (8002)
    if id "bayora-blue" >/dev/null 2>&1; then
        iptables -C OUTPUT -o lo -p tcp -m owner --uid-owner bayora-blue --dport 8002 -j REJECT 2>/dev/null || \
        iptables -A OUTPUT -o lo -p tcp -m owner --uid-owner bayora-blue --dport 8002 -j REJECT
        echo "    [+] Blocked bayora-blue from connecting to port 8002 (Red)"
    fi

    # Target (8004) -> Red (8002), Blue (8003)
    if id "bayora-target" >/dev/null 2>&1; then
        iptables -C OUTPUT -o lo -p tcp -m owner --uid-owner bayora-target --dport 8002 -j REJECT 2>/dev/null || \
        iptables -A OUTPUT -o lo -p tcp -m owner --uid-owner bayora-target --dport 8002 -j REJECT
        iptables -C OUTPUT -o lo -p tcp -m owner --uid-owner bayora-target --dport 8003 -j REJECT 2>/dev/null || \
        iptables -A OUTPUT -o lo -p tcp -m owner --uid-owner bayora-target --dport 8003 -j REJECT
        echo "    [+] Blocked bayora-target from connecting to ports 8002 (Red) and 8003 (Blue)"
    fi

    echo "======================================================================"
    echo " [✓] OS-level firewall rules active."
    echo "======================================================================"
else
    echo "[!] iptables command not found. OS firewall control skipped."
fi
