import type { Metadata } from "next";
import "./globals.css";
import "./scheduling.css";
import "./design-system.css";
import "./print-schedule.css";

export const metadata: Metadata = {
  title: "Shiftly | Team Scheduling",
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
