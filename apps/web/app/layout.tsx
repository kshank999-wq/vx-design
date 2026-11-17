import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VX Design",
  description: "Spec-driven electronics and hardware engineering platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
