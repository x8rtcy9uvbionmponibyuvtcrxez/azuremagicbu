import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** @type {import('next').NextConfig} */
const baseConfig = {};

export default function nextConfig(phase) {
  return {
    ...baseConfig,
    // Keep dev artifacts separate from production build output.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"
  };
}
