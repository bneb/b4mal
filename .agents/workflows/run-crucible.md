---
description: How to run the b4mal crucible benchmark on a remote Linux machine
---

## Running the Crucible on a Remote Linux Node

The Crucible (`src/benchmarks/crucible.ts`) is a 5-phase bare-metal stress test for the b4mal build engine. It must be run on a Linux machine with a real NVMe SSD and multi-core CPU for high-fidelity results.

### Prerequisites (one-time)

On the Linux box, SSH must be enabled and auto-start on boot:
```bash
# Run this locally on the Linux box (once, with monitor attached)
sudo systemctl enable ssh
sudo systemctl start ssh
```

Verify the box's current IP (DHCP can change between reboots):
```bash
ip addr | grep "inet " | grep -v 127
```

### Option 1: One-liner deploy script

```bash
# From the b4mal project root on your Mac:
bash scripts/crucible_deploy.sh main@192.168.68.68 %YourPassword%
```

This script:
1. Installs your `~/.ssh/id_rsa.pub` for future passwordless access
2. Installs Node via apt-get
3. rsyncs the repo (no .git, no node_modules)
4. Runs `bun install`
5. Runs the crucible, saving output to a timestamped `.log` file

### Option 2: Manual steps

```bash
# Install SSH key (one-time, with password)
ssh-copy-id main@<IP>

# Install system deps
ssh main@<IP> "echo 'PASSWORD' | sudo -S apt-get install -y nodejs"

# Sync repo
rsync -az --exclude='.git' --exclude='node_modules' \
    -e ssh /path/to/b4mal/ main@<IP>:~/b4mal/

# Install packages and run
ssh main@<IP> "cd ~/b4mal && bun install && bun run src/benchmarks/crucible.ts 2>&1" \
    | tee crucible_$(date +%Y%m%d).log
```

### Interpreting Results

| Phase | What it measures | Key metric |
|---|---|---|
| 1. Workspace Gen | NVMe write speed (crypto-random) | MB/s write |
| 2. ContentHasher | SHA-256 + stream throughput | MB/s (cold vs hot) |
| 3. PrefixTree QF_S | Algorithm overhead, solver speed | proofs/sec, p50/p99 ms |
| 4. SQLite WAL | Concurrent write contention | TPS, SQLITE_BUSY count |
| 5. tar/zstd | Archive pack/unpack throughput | MB/s |

### Reference Results (UM890 Pro, Ryzen 9 PRO 8945HS, 29GB DDR5)

| Phase | Result |
|---|---|
| NVMe write throughput | 990 MB/s |
| SHA-256 throughput (cold) | 1,335 MB/s |
| SHA-256 throughput (cached) | 1,436 MB/s |
| PrefixTree proofs/sec | 351 |
| SQLite TPS | 1,005 (0 SQLITE_BUSY) |
| zstd pack | 1,353 MB/s |
| zstd unpack | 1,117 MB/s |

> **Note:** After v4.4.0, the Crucible now tests the zstd vault (`tar|zstd -T0`). Expect significantly higher pack throughput on the Linux box.

### Notes

- The script **auto-cleans** the ~1GB `crucible_workspace` after each run via a `finally` block — the SSD is safe.
- DHCP can change the IP between reboots. Always verify with `ip addr` on the Linux box.
- The timing tests in the main test suite (`bun test`) have tight thresholds (250ms, 20ms) that can be flaky on loaded machines — these are not related to the crucible.
