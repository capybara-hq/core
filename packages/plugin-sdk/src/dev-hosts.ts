/**
 * The dev hosts preset: common package registries, source hosts and tool downloads the `dev`
 * sandbox tier adds to the org's allowlist. The kernel's `sandbox.limits.devHosts` defaults to it;
 * the device and the sandbox plugins read the same list. Every entry passes `validateAllowHost`.
 */
export const DEV_HOSTS: readonly string[] = Object.freeze([
  // npm / Node
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "nodejs.org",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // GitHub
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
  // Rust
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // JVM
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
  "downloads.gradle.org",
  // Docker Hub (image metadata and layers for tools such as crane)
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
  // Playwright browsers
  "cdn.playwright.dev",
  "playwright.download.prss.microsoft.com",
]);
