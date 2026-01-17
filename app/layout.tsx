import "./globals.css";

export const metadata = {
  title: "F0 Visualizer (YIN)",
  description: "Local-only F0 visualizer using YIN + WebWorker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
