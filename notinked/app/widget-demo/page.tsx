import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NotInked Widget Demo",
};

export default function WidgetDemoPage() {
  return (
    <main className="max-w-xl mx-auto px-5 py-16 text-white">
      <h1 className="text-2xl font-bold mb-2">Embeddable Widget Demo</h1>
      <p className="text-muted text-sm mb-8">
        Drop this into any Ink dApp to show a risk badge next to a contract or spender
        address, before a user approves it.
      </p>

      <div className="bg-ink2 border border-white/10 rounded-lg p-5 mb-8">
        <div className="text-xs font-mono text-muted mb-3">Example: contract address</div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm">0x1234...abcd</span>
          <span data-notinked-address="0x1234567890123456789012345678901234abcd" />
        </div>
      </div>

      <div className="text-xs text-muted font-mono bg-ink2 border border-white/10 rounded-lg p-4 whitespace-pre-wrap">
{`<div data-notinked-address="0x..."></div>
<script src="https://notinked.xyz/widget.js"></script>`}
      </div>

      <script src="/widget.js" async />
    </main>
  );
}
