import type { Metadata } from "next";
import "./globals.css";
import "./scheduling.css";
import "./design-system.css";
import "./launch.css";
import "./print-schedule.css";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Meadowmark | Team Scheduling",
  description:
    "Simple scheduling, time-off requests, and shift swaps for small teams.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
