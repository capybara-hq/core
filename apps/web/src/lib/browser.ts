/** 整页跳转到外部地址（单独成模块，测试里可替换）。 */
export function navigateBrowser(url: string): void {
  window.location.assign(url);
}
