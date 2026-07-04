import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Static export — deployed as plain static files (see EdgeOne Pages deploy), no Next server needed.
  output: 'export',
  images: { unoptimized: true },
  // The sandbox this builds in (BrowserPod) is a WebAssembly Node emulator that can't execute Next's
  // native Rust SWC binary. Force the WASM build explicitly (see the "@next/swc-wasm-nodejs"
  // dependency in package.json) so Next never probes for a native binary or tries to download the
  // wasm one at runtime — the latter is known to hang indefinitely in wasm32 sandboxes.
  experimental: {
    useWasmBinary: true,
  },
};

export default nextConfig;
