# Core Engine

The B4mal Core encapsulates all fundamental state management, caching, and formal verification subsystems. It provides the immutable foundations upon which the Orchestrator builds execution waves.

## Subsystems

### The Artifact Vault (`artifact_vault.ts`)
The `ArtifactVault` implements the L1 (local) cache. It strictly enforces filesystem isolation using POSIX Kernel-level `O_NOFOLLOW` file descriptors to mitigate Time-Of-Check to Time-Of-Use (TOCTOU) symlink breakout attacks. 

We utilize a shell pipeline (`tar -cf - ... | zstd -T0`) for maximum multi-core pack and unpack throughput, decoupling the I/O bounds of the JavaScript runtime from the compression bottleneck.

### Logic Hashing (`logic_hasher.ts` & `content_hasher.ts`)
Determinism requires exact input signatures. 
1. **ContentHasher**: Computes SHA-256 signatures of filesystem dependency trees.
2. **LogicHasher**: Computes Merkle representations of execution configurations. It buffers inputs from file descriptors to provide OOM immunity against V8 string engine limits (Max String Length 1024MB on 64-bit systems).

### The Formal Shadow (`formal_shadow.ts`)
Prior to parallel execution, overlapping state claims are formally verified using Microsoft's Z3 SMT solver. The Formal Shadow constructs propositional logic (`QF_S`) equations of directory prefixes and file sets to prove that two execution waves are disjoint.

## Security Guarantees
- **Symlink Breakouts**: Impossible. Verified via inode and device ID mapping during file descriptor extraction.
- **Race Conditions**: Mitigated. Caching operations operate strictly on path prefixes evaluated at runtime, locking concurrency models dynamically.
- **Cache Poisoning**: Rejected. Arbitrary execution inputs are isolated to ephemeral scratchpads (`.b4mal/shadow`) prior to Vault archiving.
