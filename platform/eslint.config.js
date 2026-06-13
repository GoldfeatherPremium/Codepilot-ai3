// eslint.config.js - flat config for ESLint 9 with Next.js 15
const nextConfig = require("eslint-config-next/core-web-vitals");

module.exports = Array.isArray(nextConfig) ? nextConfig : [nextConfig];
