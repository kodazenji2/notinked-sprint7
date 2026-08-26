import "./globals.css";

export const metadata = {
  title: "NotInked",
  description: "Check before you get inked. Wallet safety for Ink chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink text-white min-h-screen">{children}</body>
    </html>
  );
}
