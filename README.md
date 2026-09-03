# Pi Node Telegram Controller PRO — SoloHost Edition

A Telegram + local assistant that watches your **Pi Node** 24/7 from **Pi Desktop SoloHost**.

You get a clear picture of node health without sitting at the machine all day. The default install stays inside SoloHost sandbox rules: **no Docker socket**, read-only style monitoring over HTTP and ports.

**Image:** `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.33`

---

## What it does

- **Live monitoring** — sync, ledger, ledger age, ports 31401–31403, optional Core HTTP, optional Docker (only if you enable it on the PC).
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
| 5 | Optional `docker.sock` + exec | Container name, Core `/info` inside the node, peers — **only after you opt in on SoloHost UI** |

When Docker is enabled, those fields feed the **same** places as Horizon: `/status`, `/report`, `/diagnostic`, `/peers`, history, and AI.

---

## Install (SoloHost)

1. Publish / pull image `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.33`.
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

## Optional Docker (advanced)

Default listing promise: **no docker.sock**.

To add container-level reads:

1. On the **node PC**, open the SoloHost app window (`http://127.0.0.1:18780/`).
2. **Optional Docker…** → scroll the terms to the end → check both boxes → **Confirm**.
3. SoloHost bar: **Stop**, then **Start** again.

Telegram cannot raise Docker privileges. You (Operator) accept the extra host permission under SoloHost Terms.

---

## Security

- Answers only the configured `CHAT_ID`.
- Tokens and API keys are redacted in logs.
- HTTP UI binds through SoloHost localhost mapping; security headers on responses.
- Rate limits on `/api/status` and `/api/chat`.
- No wallet access. Docker socket is opt-in only.

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

Community utility. You operate it on your own machine. SoloHost and this publisher do not guarantee node rewards or host security. Optional elevated Docker access is your choice and risk.


## SoloHost dashboard quick actions

The local window (`http://127.0.0.1:18780/`) mirrors Telegram buttons:

HELP · STATUS · REPORT · PEERS · DIAG · ANALYZE · LOGS · DONATE

Reports list **issue windows** (start → end) when sync, ports, or level were bad. AI receives a **pre-eval brief** plus raw facts so answers stay grounded.

## Data frame
All sources (Horizon, Core, Docker) are written to one schema (`data-frame.js`): sync, ledger, peers, ports, docker, resources. If total peers < 8, Incoming = 0 and Outgoing = total. History and `latest.json` use atomic writes.

## Alerts (v2.6.33)
First alert after repeated bad samples. Lasting issues get a reminder about every 30 minutes with duration. Short catch-up / upgrade / network blips are classified with optional AI so Telegram is not spammed.

## Alerts mute
Every alert includes buttons: 1h, Night (22:00-07:00), 24h, Off, On. Confirmed after 3 samples; 30-minute dedupe; AI may suppress short catch-up like Windows PRO.
