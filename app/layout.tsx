import "./globals.css";

export const metadata = {
  title: "Tone Visualizer",
  description: "Local-only F0 visualizer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
