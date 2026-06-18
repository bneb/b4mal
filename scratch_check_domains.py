import subprocess
import concurrent.futures

names = [
    "velo", "velox", "glide", "tempo", "aero", "zeno", "lumo", "shift", "flux", "surge",
    "pulse", "loom", "mint", "ray", "nova", "apex", "prism", "tide", "plume", "snap",
    "zest", "flare", "meld", "chord", "cadence", "motif", "coda", "swift", "zephyr", "breeze",
    "faze", "nexa", "tach", "alto", "arise", "aura", "axis", "base", "beam", "bolt",
    "core", "crest", "dash", "dawn", "drift", "edge", "emit", "epic", "era", "ever",
    "flow", "form", "fuse", "halo", "hue", "icon", "idle", "ignite", "illume", "inertia",
    "jump", "kite", "lark", "leap", "link", "lucid", "merge", "node", "opal", "pace",
    "peak", "pivot", "propel", "rise", "rush", "sail", "scale", "scope", "soar", "spark",
    "spin", "spire", "sync", "tact", "tilt", "tone", "trace", "trek", "trim", "vane",
    "veer", "vital", "wake", "warp", "wave", "whip", "wind", "zenith", "vertex", "strata"
]

tlds = [".dev", ".run", ".build"]

def check_domain(domain):
    # Run host command
    result = subprocess.run(["host", domain], capture_output=True, text=True)
    if "not found" in result.stdout:
        return domain, True
    return domain, False

domains_to_check = [name + tld for name in names for tld in tlds]
available = {tld: [] for tld in tlds}

with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
    results = executor.map(check_domain, domains_to_check)
    for domain, is_avail in results:
        if is_avail:
            tld = "." + domain.split(".")[1]
            available[tld].append(domain)

for tld in tlds:
    print(f"--- Available {tld} ---")
    print(", ".join(available[tld]))
