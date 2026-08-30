# NotInked

Wallet safety checker for Ink chain (Kraken's L2). "Check before you get inked."

## Agile plan — 2 sprints

### Sprint 1 (this scaffold): On-chain approval scanner
- Paste a wallet address
- Scans `Approval` events on Ink for that wallet
- Flags: unlimited (max uint256) approvals, spenders on a known-risk list
- Ships as a standalone useful tool — no dependency on Sprint 2

**Definition of done:** paste an address, get a red/yellow/green list of active approvals with plain-English reasons.

### Sprint 2 (implemented): Message/link scam checker
- Paste a DM, airdrop offer, or link
- Sent to **Groq** (free tier, `openai/gpt-oss-20b`) with a scam-pattern prompt (urgency language, fake support impersonation, seed-phrase requests, unrealistic yield claims)
- Returns a risk score + what triggered it
- Rate-limited to **5 free checks/day** per user, backed by Upstash Redis so the counter survives deploys and cold starts
- Added as a second tab in the same UI — Sprint 1 keeps working untouched

**Definition of done:** paste text, get a risk score + explanation, capped at 5/day free. ✅ Done in this scaffold.

**Not yet done:** premium tier bypass is wired (`isPremium` flag) but nothing sets it yet — needs wallet-signature auth + a subscription check (Stripe or onchain) before it's real.

### Sprint 3 (implemented): Open infrastructure for other Ink builders
The pivot from "consumer app" to "shared infrastructure" — this is what makes NotInked useful to Ink builders and the Ink Foundation itself, not just individual users.

- **`GET /api/public/risk-list`** — the full open risk registry as JSON, CORS-open, no auth, no rate limit. Any Ink builder (Tydro, Nado, or anyone else) can pull this directly instead of maintaining their own scam-address list.
- **`GET /api/public/risk-check?address=0x...`** — single-address lookup, same open access. What the embeddable widget calls.
- **`public/widget.js`** — a dependency-free embeddable script. Any site adds `<div data-notinked-address="0x...">` + one `<script>` tag and gets a live risk badge, no build step or framework required.
- **`/widget-demo`** — a live demo page showing the widget rendering, with the embed snippet other builders would copy.
- The wallet scanner (Sprint 1) and the risk registry are now unified — both read from `lib/riskRegistry.ts`, so the public API and the app itself never drift out of sync.

**Definition of done:** a third party can fetch the registry or embed the badge without talking to you first. ✅ Done in this scaffold.

**Not yet done:** `RISK_REGISTRY` in `lib/riskRegistry.ts` is still an empty seed array — this is infrastructure with no data in it yet. Before pitching this to Tydro/Nado or Ink Foundation, populate it with real, sourced entries (community reports, GoPlus feed, or your own findings), and ideally get one of those teams to actually test embedding the widget — that's the strongest evidence for a Spark application.

### Sprint 4 (implemented): Pre-ape contract checker
The three tools now cover three different moments: **before** you interact with something new (this), what you already gave permission to (Sprint 1), and a suspicious message someone sent you (Sprint 2).

- **New tab: "Before You Ape"** — paste a contract/token address before interacting with it
- Checks three things: (1) our own open risk registry, (2) source code verification status via Ink's Blockscout explorer API, (3) deployment age — very new contracts are flagged as higher risk
- Uses `explorer.inkonchain.com`'s own API — chosen over GoPlus Security API because GoPlus's Ink chain support couldn't be confirmed as of this writing, while Blockscout is guaranteed to support Ink since it *is* Ink's own explorer
- No API key needed, free

**Definition of done:** paste an address, get verified/unverified + deployment age + registry match, before you've interacted with it. ✅ Done in this scaffold.

The original scaffold did not do deep bytecode analysis, but later Sprint 9 checks now cover verified ABI function names and token-holder concentration. Honeypot sell-tax detection and hidden behavior in unverified bytecode remain outside the current scope.

### Sprint 5 (implemented): Two-step verification, based on how Revoke.cash actually works
Research into Revoke.cash (the established open-source leader in this space) surfaced the real architecture pattern, and one confirmed fact about Ink specifically that unlocks it:

- **Multicall3 is deployed on Ink** at the standard address (`0xcA11bde05977b3631167028862bE2a173976CA11`) — confirmed via the official multicall3 deployments registry. viem's default chain config for Ink doesn't include it yet, so it's now added explicitly in `lib/scanWallet.ts`.
- **RPC swapped** from `rpc-gel.inkonchain.com` to NodeFlare's free public Ink endpoint, which documents full, unthrottled access to `eth_getLogs` — matters for the discovery step below.
- **The scanner is now two steps, matching Revoke.cash's actual pattern:**
  1. **Discovery** — scan Approval event logs to find every (token, spender) pair ever approved.
  2. **Verification** — batch a **live** `allowance()` read for every discovered pair in one Multicall3 call. This fixes a real correctness bug: an Approval event only shows the value that was *set*, not what remains after any partial `transferFrom()` spends since. Trusting the event value alone (the old behavior) could show a stale or wrong number. Live verification is the only way to know the actual current exposure.

**Definition of done:** every approval shown reflects a live on-chain read, not a historical event value. ✅ Done in this scaffold.

The later Sprint 6 implementation replaced the bounded raw-log scan with Blockscout's indexed full-history endpoint. Completeness therefore depends on Blockscout indexing and its API response limits.

### Sprint 6 (implemented): Simplified discovery, honest product framing
Two changes, both aimed at not building things that already exist:

- **Discovery no longer chunks raw chain logs.** It queries Ink's Blockscout explorer directly (`explorer.inkonchain.com/api`, Etherscan-compatible `getLogs`), which already indexes every log on the chain in its own database. This is a standard, accepted approach — Revoke.cash's own public chain-support requirements explicitly list "a block explorer with an exposed API compatible with Etherscan's API (such as Blockscout)" as sufficient for full historical discovery. Result: genuinely full history, one request, no custom indexer needed. All the chunking/MAX_CHUNKS complexity from Sprint 4/5 is gone.
- **Product framing shifted.** Revoke.cash already supports Ink and does wallet-approval scanning well — that's a solved, commoditized problem, not a moat. Wallet Scan is now positioned as a convenience feature inside NotInked, not the pitch. The actual differentiation is the other two tools: the pre-ape contract checker and the AI message checker — both less crowded, both genuinely Ink-specific in how they're built.

**Definition of done:** wallet scan returns true full history in one request, and the app's framing reflects where the real differentiation is. ✅ Done in this scaffold.

### Sprint 7 (implemented): Widget now matches the app's real logic
Previously `/api/public/risk-check` (what the embeddable widget calls) only checked the risk registry — a weaker signal than the "Before You Ape" tab, which also checks verification status and deployment age. That mismatch meant an embedding builder got a worse answer than NotInked's own users. Fixed:

- `/api/public/risk-check` now calls the same `checkContract()` used by "Before You Ape" — registry + verification + age, every time
- `public/widget.js` updated to handle the real `red`/`yellow`/`green` values (was previously stubbed for a `red`/`unknown`-only response), and the badge tooltip now shows the actual reasons, not a generic label

**Definition of done:** the widget and the in-app tab always agree, because they now run the same function. ✅ Done in this scaffold.

**Note on the visual theme:** the app uses the palette defined in `tailwind.config.js`; the current primary accent is green (`#4FE0A8` in the original theme).

### Sprint 9 (implemented): Deeper contract, wallet, and message signals
- Contract checks now inspect verified ABIs for dangerous functions, detect standard proxies, measure token-holder concentration, and flag possible name spoofing.
- Wallet scans include ERC-721/1155 `ApprovalForAll` events and enrich approval operators with contract checks.
- Message checks resolve URLs and inspect hexadecimal addresses mentioned in the text.
- Automated findings are kept separate unless a real transaction hash is supplied; the registry never fabricates transaction evidence.

**Known limitations:**
- Dangerous-function detection only works on verified contracts with a published ABI; unverified malicious contracts can hide these functions.
- EIP-1967 detection only catches the standard proxy pattern; custom proxies can evade it.
- Holder concentration is a point-in-time snapshot and can change immediately after a check.
- Name spoofing only covers the hardcoded `USDC`, `USDT`, `WETH`, and `DAI` symbol list.
- NFT approval risk is weaker than ERC20: there is no amount signal, so an unregistered drainer that passes contract checks can appear low-risk despite blanket NFT control.
- Cross-pollination adds one full contract check per unique spender/operator. A wallet with many approvals will scan more slowly; a TTL cache would be the next optimization.
- Permit-based approvals such as EIP-2612 remain invisible because they do not emit the events this scanner searches for.

### Farmer activity checker (separate tool)
`/ink-activity-checker` is intentionally separate from the safety product. It reports verifiable wallet activity snapshots for INK farmers, including indexed interactions with the supplied Nado mainnet contracts and the TydroInkPoints token address. It does not calculate points, estimate an allocation, or claim eligibility because official weighting is unpublished.

The main `/` page remains limited to **Before You Ape**, **Wallet Scan**, and **Message Check**. It does not include points, farming scores, or $INK eligibility estimates.
- Automatic findings without transaction evidence are not added to the public risk registry; a persistent evidence model is needed for non-transaction findings.

---

## Setup

```bash
npm install
cp .env.example .env.local
# then edit .env.local and add a free Groq key from console.groq.com
npm run dev
```

Open http://localhost:3000

## Rate limiting (Sprint 2)
- Free: 5 checks/day per session, resets at UTC midnight
- Premium: 100/day (placeholder for "unlimited") — gated behind an `isPremium` flag that nothing sets yet
- Rate limiting is now session-based: each user gets a long-lived session ID that persists for 30 days, ensuring true per-user limiting without requiring wallet connection or being bound to IP address.
- Wallet addresses are still accepted and take priority over session limiting; if provided, the user is identified by their wallet instead of session.
- Sessions are stored in Upstash Redis with a 30-day TTL. The client must send the `sessionId` in the request body to reuse their quota across multiple visits.
- Storage now persists in Upstash Redis via `lib/rateLimit.ts`, `lib/cache.ts`, `lib/riskRegistry.ts`, and `lib/session.ts`, so registry entries, TTL cache values, daily limits, and user sessions survive deploys and cold starts instead of resetting on every restart.

## Stack
- Next.js 16 (App Router)
- viem — reads Ink chain directly, no backend indexer needed for v1
- Tailwind for styling

## How the scan works (`lib/scanWallet.ts`)
1. Queries Ink's Blockscout index for ERC20 `Approval` and NFT `ApprovalForAll` events where `owner` = the pasted wallet.
2. Keeps the latest event for each token/spender or collection/operator pair.
3. Verifies ERC20 allowances live through Multicall3 and retains only nonzero allowances; NFT approvals retain only the latest `approved: true` state.
4. Enriches spenders/operators with the contract checker and returns structured risk results — no wallet connection required, read-only.

## Current next steps
- Move reporter identities and consensus to persistent storage so it survives restarts and remains resistant to spoofed identities.
- Add a non-transaction evidence model for ABI, proxy, holder, and message findings.
- Add broader tests for Blockscout response parsing, approval state reduction, and external API failure cases.

## Embedding
Add the browser widget to any Ink dashboard:

```html
<div data-notinked-address="0xYourAddress"></div>
<script src="https://YOUR_DEPLOYED_DOMAIN/widget.js" defer></script>
```

The script calls `/api/public/risk-check` and renders a single-address risk badge. It is currently contract/address-focused; wallet and message widgets, custom themes, callbacks, and an iframe wrapper are not implemented yet. The public endpoints are CORS-friendly, but consumers should still add their own caching and rate-limit handling.
