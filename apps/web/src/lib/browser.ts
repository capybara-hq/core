/** 整页跳转到外部地址（单独成模块，测试里可替换）。 */
export function navigateBrowser(url: string): void {
  window.location.assign(url);
}

/**
 * Reloads the document (a separate module so tests can replace it): after an admin action that
 * changes the client code the page should run, which a loaded document cannot pick up itself.
 */
export function reloadDocument(): void {
  window.location.reload();
}
