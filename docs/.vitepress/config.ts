import { defineConfig } from "vitepress";

export default defineConfig({
  title: "B4mal",
  description: "Fast, deterministic build orchestrator for monorepos",
  lang: "en-US",
  cleanUrls: true,
  // Served from https://bneb.github.io/b4mal/ by the Pages workflow. VitePress
  // prefixes this onto nav, sidebar, logo and asset links, but NOT onto raw
  // markdown links — so in-page links are relative .md paths rather than
  // root-absolute ones, which would 404 under this prefix.
  base: "/b4mal/",
  srcExclude: ["**/README.md"],

  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/concepts/determinism" },
      { text: "Reference", link: "/reference/cli" },
      // b4mal/b4mal is a typosquat, not us. The documentation-claims audit
      // missed this because it only reads markdown files.
      { text: "GitHub", link: "https://github.com/bneb/b4mal" },
    ],
    sidebar: {
      "/guide/": [
        { text: "Getting Started", link: "/guide/getting-started" },
        { text: "Installation", link: "/guide/installation" },
        { text: "Configuration", link: "/guide/configuration" },
        { text: "vs. Turborepo", link: "/guide/vs-turborepo" },
        { text: "Migration", items: [
          { text: "From Turborepo", link: "/guide/migration/turborepo" },
          { text: "From Nx", link: "/guide/migration/nx" },
          { text: "From Lerna", link: "/guide/migration/lerna" },
        ]},
      ],
      "/concepts/": [
        { text: "Determinism", link: "/concepts/determinism" },
        { text: "Resource Isolation", link: "/concepts/resource-isolation" },
        { text: "Caching", link: "/concepts/caching" },
        { text: "Security Model", link: "/concepts/security-model" },
      ],
      "/reference/": [
        { text: "CLI Commands", link: "/reference/cli" },
        { text: "Configuration Schema", link: "/reference/schema" },
        { text: "Lockfile Format", link: "/reference/b4mal-lock" },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/bneb/b4mal" },
    ],
    search: { provider: "local" },
    footer: {
      message: "Released under the MIT License.",
    },
  },
});
