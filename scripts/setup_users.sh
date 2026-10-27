#!/usr/bin/env bash
# ==============================================================================
# Bayora - Provision Dedicated OS Service Accounts (Linux / macOS)
# ==============================================================================
# Track 4: Securing Adversarial AI Safety Testing Infrastructure
#
# Creates separate unprivileged OS user accounts for each Bayora role:
#   - bayora-cp       (Control plane)
#   - bayora-witness  (Independent audit witness)
#   - bayora-red      (Red team attack agent)
#   - bayora-blue     (Blue team defense agent)
#   - bayora-target   (Target model agent)
#
# Applies strict discretionary access control (DAC):
#   - .run/cp       -> owned by bayora-cp:bayora-cp (mode 0700)
#   - .run/witness  -> owned by bayora-witness:bayora-witness (mode 0700)
#   - .run/red      -> owned by bayora-red:bayora-red (mode 0700)
#   - .run/blue     -> owned by bayora-blue:bayora-blue (mode 0700)
#   - .run/target   -> owned by bayora-target:bayora-target (mode 0700)
#
# Red agent OS user CANNOT read Blue agent directory or key files.
# Requires root privileges (sudo).
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$PROJECT_ROOT/.run"

if [ "$(id -u)" -ne 0 ]; then
    echo "[!] This script requires root privileges to create system users."
    echo "    Usage: sudo bash $0"
    exit 1
fi

ROLES=("cp" "witness" "red" "blue" "target")

echo "======================================================================"
echo " Bayora: Provisioning Dedicated OS Service Accounts"
echo "======================================================================"

for role in "${ROLES[@]}"; do
    username="bayora-$role"
    if id "$username" >/dev/null 2>&1; then
        echo "    [*] User $username already exists."
    else
        echo "    [+] Creating unprivileged system user $username..."
        if command -v useradd >/dev/null 2>&1; then
            useradd --system --no-create-home --shell /usr/sbin/nologin "$username"
        elif command -v sysadminctl >/dev/null 2>&1; then
            # macOS system user creation
            sysadminctl -addUser "$username" -role guest || true
        else
            echo "    [!] Could not determine user creation command on this OS."
        fi
    fi
done

# If .run exists, set ownership per role
if [ -d "$RUN_DIR" ]; then
    echo "[*] Applying per-role filesystem ownership and 0700 permissions..."
    for role in "${ROLES[@]}"; do
        username="bayora-$role"
        role_dir="$RUN_DIR/$role"
        if [ -d "$role_dir" ]; then
            chown -R "$username:$username" "$role_dir" 2>/dev/null || chown -R "$username" "$role_dir"
            chmod 700 "$role_dir"
            if [ -f "$role_dir/env.json" ]; then
                chmod 600 "$role_dir/env.json"
            fi
            echo "    [+] $role_dir restricted to $username (0700/0600)"
        fi
    done
else
    echo "[!] $RUN_DIR does not exist yet. Run 'python -m app.local_setup' first."
fi

echo "======================================================================"
echo " Service accounts provisioned. OS-level DAC separation ready."
echo "======================================================================"
