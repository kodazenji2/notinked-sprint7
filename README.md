# NotInked 🛡

**Check before you sign. Scan before you click.**
NotInked is a wallet safety tool for the Ink chain (Kraken's L2). It helps users spot risky contracts, dangerous token approvals and scam messages before they lose funds.

🔗 **Live app:** [https://notinked.xyz]

---

## Why NotInked?

Most wallet losses happen in one of three ways: interacting with a malicious contract, leaving old approvals open, or trusting a scam message. NotInked covers all three in one place.

## Features

### 1. Pre-Ape Contract Check
Paste a contract address **before** you interact with it. NotInked analyses it and returns a risk summary so you can decide with more information.

- Input: contract address
- Output: risk level and reasons e.g. verified source, ownership, proxy/upgradeable, etc

### 2. Wallet Approval Scan
Scan your wallet for token approvals you've granted in the past and see which ones are risky or unlimited.

- Input: wallet address
- Output: list of active approvals with risk flags
- Revoke: Not yet implemented in V1 since some more robust tools like revoke(dot)cash do this effectively.

### 3. AI Message Scam Check
Paste a suspicious message or link. An LLM-powered checker flags common scam patterns such as fake airdrops, urgency tricks and phishing links.

- Powered by: Groq
- Free: 5 checks per day per user
- Premium tier: [coming soon]

---

## How to use

1. Go to notInked.xyz
2. Choose a tool:
   - → paste contract → read risk report
   - **Scan my wallet** → review approvals
   - **Check a message** → paste text or link
4. Act on the results (avoid, or proceed with care)

> ⚠ **Disclaimer:** NotInked gives risk indicators, not guarantees. A "low risk" result does not mean a contract or message is safe. Always do your own research.

---

## Tech stack

- **Frontend:** [TypeScript]
- **Chain data:** [Ink RPC, explorer API]
- **AI:** Groq (LLM scam message detection)
- **Hosting:** [Paid Services using .xyz domain]

## Architecture (short)

```
User → Frontend → API routes → [Ink RPC / explorer] → risk rules
                            └→ Groq LLM → scam verdict
```

## Limitations (honest section)

- Risk scoring is rule- and model-based and can produce false positives and false negatives.
- LLM output is probabilistic, so treat it as a second opinion.
- Wallet approval scanning overlaps with tools like Revoke.cash; NotInked's focus is the pre-interaction contract check and AI message check.

## Roadmap

- [ ] Premium tier with higher message-check limits
- [ ] Expanded contract risk rules
- [ ] [Widget integration]

## Run locally

```bash
git clone https://github.com/KodaZenji2/notinked-sprint7.git
cd notinked-sprint7
npm install
cp .env.example .env   # add your own keys; never commit real ones
npm run dev
```

**Environment variables:** `GROQ_API_KEY`, `[RPC_URL]`, `[OTHER]`

## Contributing

Issues and pull requests are welcome. Please open an issue first for larger changes.

## Author

  Portfolio: kemjeelabs.xyz

## License

[MIT]
