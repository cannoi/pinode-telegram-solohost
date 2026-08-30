# SoloHost v2.6.16

Runs inside Controller container. Adaptive discovery:
- Horizon and Core searched **independently** (no early-stop when Core missing)
- Parallel reads + sticky URLs + ledger cross-check
- Core-first sync labels; Horizon-only never fakes Desktop Synced

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.16`
