import type { NextConfig } from "next";
const config: NextConfig = {
  // TypeScript 5 exposes the compiler API; avoid spawning a separate CLI.
  experimental: { useTypeScriptCli: false },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};
export default config;
