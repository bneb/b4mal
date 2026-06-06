#!/usr/bin/env python3
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# b4mal Core Shim — Python Edition (v2.0.0)
#
# Zero-dependency bridge from Python functions to the b4mal engine.
# Drop this file into your Python project.
#
# The shim communicates with the locally-installed `b4mal` binary
# via `subprocess.Popen` (fire-and-forget telemetry).
#
# Usage:
#   import b4mal
#   
#   @b4mal.core_shield(["fs:write:db/local.sqlite", "env:API_KEY"])
#   def process_data():
#       ...
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import subprocess
import functools
import os
import sys

def core_shield(resources=None):
    """
    Attest that the decorated function requires access to specific resources.
    
    This triggers a Path-based Isolation check in the b4mal engine.
    The engine verifies that no other concurrent test claims
    overlapping resources (the disjointness constraint).
    
    Args:
        resources (list): List of resource claim strings (e.g., "fs:path", "port:80")
    """
    if resources is None:
        resources = []

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if resources:
                try:
                    # Fire-and-forget subprocess to avoid blocking the Python thread
                    env = os.environ.copy()
                    env["B4MAL_CALLER"] = "python-shim-v2.0.0"
                    
                    subprocess.Popen(
                        ["b4mal", "attest", func.__name__, *resources],
                        env=env,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        # Close file descriptors so the child doesn't hang the parent
                        close_fds=True
                    )
                except Exception:
                    # Silent failure: if b4mal isn't installed, degrade gracefully.
                    # The function runs unprotected but functional.
                    pass
                    
            return func(*args, **kwargs)
        return wrapper
    return decorator

# If run directly, run a quick availability check
if __name__ == "__main__":
    try:
        subprocess.run(
            ["b4mal", "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True
        )
        print("b4mal engine detected — formal isolation active")
        sys.exit(0)
    except FileNotFoundError:
        print("[WARN] b4mal not in PATH — tests will run without protection")
        sys.exit(1)
