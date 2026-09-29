# Pi Node Telegram Controller PRO — SoloHost Edition

A Telegram + local assistant that watches your **Pi Node** 24/7 from **Pi Desktop SoloHost**.

You get a clear picture of node health without sitting at the machine all day. The default install stays inside SoloHost sandbox rules: **no Docker socket**, read-only style monitoring over HTTP and ports.

**Image:** `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.66`

---

## What it does

- **Live monitoring** — sync, ledger, ledger age, ports 31401–31403, optional Core HTTP. No Docker access of any kind.
- **Smart alerts** — notifies when something meaningful changes (not every small fluctuation).
- **Simple reports** — `/status`, `/report`, `/peers`, `/diagnostic` with icons anyone can read.
- **Natural questions** — ask in your language; optional Gemini AI answers from real telemetry and history.
- **Local UI** — `http://127.0.0.1:18780/` on the node PC (status + chat).
- **History** — samples stored for trends and AI analysis.

It does **not** access your Pi wallet or keys.

---

## Who it is for

Pi Node operators who want remote peace of mind: fewer false alarms, faster diagnostics, and practical guidance when something needs attention.

---

## How data is read (no machine-name lock-in)

Works the same on Testnet or Mainnet. Container names are labels only.

| Priority | Source | What you get |
|----------|--------|----------------|
| 1 | Horizon HTTP (`31401` or discovered) | Ledger, ingest, network, versions |
| 2 | Stellar Core HTTP (`11626` / fallbacks) | Official sync state, peers |
| 3 | TCP ports `31401–31403` | Open / closed |
| 4 | Local history / state files | Trends, last known good |

All sources feed the same places: `/status`, `/report`, `/diagnostic`, `/peers`, history, and AI.

---

## Install (SoloHost)

1. Publish / pull image `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.66`.
2. Install the two SoloHost files (`docker-compose.yml` + `config_options.yml`).
3. Set **BOT_TOKEN** and **CHAT_ID**. Optional: **GEMINI_API_KEY**.
4. Start the app. Telegram should show the command menu.

**Telegram menu**

| Command | Meaning |
|---------|---------|
| `/status` | Current node health snapshot |
| `/sync` | Sync status and latest ledger |
| `/peers` | Inbound and outbound peers |
| `/report` | Recent history summary |
| `/diagnostic` | Technical source details |
| `/analyze` | AI technician review |
| `/logs` | App activity and errors |
| `/donate` | Support the project |
| `/winpro` | Windows PRO edition link |
| `/ping` | Controller heartbeat |
| `/help` | List available commands |

Free-text questions also go to the technician assistant.

---


## Security

- Answers only the configured `CHAT_ID`.
- Tokens and API keys are redacted in logs.
- HTTP UI binds through SoloHost localhost mapping; security headers on responses.
- Rate limits on `/api/status` and `/api/chat`.

Use **one** bot token on **one** running instance. Two pollers on the same token cause Telegram `getUpdates` conflicts.

---

## Windows PRO

Full Windows edition (more host tools):  
https://github.com/cannoi/pinode-telegram-controller

---

## Support

Pay with Pi or MB Bank via `/donate` in Telegram.

---

## License / disclaimer

Community utility. You operate it on your own machine. SoloHost and this publisher do not guarantee node rewards or host security.


## SoloHost dashboard quick actions

The local window (`http://127.0.0.1:18780/`) mirrors Telegram buttons:

HELP · STATUS · REPORT · PEERS · DIAG · ANALYZE · LOGS · DONATE

Reports list **issue windows** (start → end) when sync, ports, or level were bad. AI receives a **pre-eval brief** plus raw facts so answers stay grounded.

## Data frame
All sources (Horizon, Core, ports) are written to one schema (`data-frame.js`): sync, ledger, peers, ports, resources. If total peers < 8, Incoming = 0 and Outgoing = total. History and `latest.json` use atomic writes.

## Alerts (v2.6.43)
First alert after repeated bad samples. Lasting issues get a reminder about every 30 minutes with duration. Short catch-up / upgrade / network blips are classified with optional AI so Telegram is not spammed.

## Alerts mute
Every alert includes buttons: 1h, Night (22:00-07:00), 24h, Off, On. Confirmed after 3 samples; 30-minute dedupe; AI may suppress short catch-up like Windows PRO.

## Repair BATs
Download from SoloHost UI action row. Suggest only after confirmed conditions (not after a single sync blip).

## v2.6.43 NetworkRepair
Keeps current LAN IP. No DHCP release/renew, no winsock/ip reset, no adapter restart.

## v2.6.43 NetworkRepair ladder
Phase1 safe -> Phase2 adapter restart keep IP -> Phase3 winsock. Never DHCP release/renew or netsh int ip reset.

## v2.6.43 Actions
Replaced legacy BAT names with pinode-actions pack: CleanRam DnsFlush Firewall NetRepair LanSetup Maintain Reboot CleanTemp.

## v2.6.43
Wallpaper picker: Cave (default), Classic, user upload (local). Win10 acrylic glass UI.

## v2.6.65 SoloHost compliance
Removed every Docker-socket / Docker-control path: no `docker` Telegram commands, no `docker_sock` telemetry, no NodeReset / DockerRecover scripts, no `/solohost-config` read-write mount, no code loaded from `/data`. Monitoring is Horizon + Core HTTP + TCP ports only.

## v2.6.66 Settings (main UI)
Button **Settings** on the main page edits: Telegram Bot Token, Chat ID, Gemini API Key, Pi Browser relay/label, Node host, Horizon port, Telemetry seconds, start message.
- Saved to `/data/state/settings.json` (mode 600). Priority: Settings > `.env`/compose > default.
- Bot Token, Chat ID, Gemini Key apply immediately. The others apply after **Restart app**.
- Secrets are never sent back to the browser (only the last 4 characters). Empty secret field = keep current.
- API is local-only, JSON-only, same-origin only, rate-limited.
