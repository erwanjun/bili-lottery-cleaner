// 点击工具栏图标：在B站页面上切换面板；不在B站页面则打开自己的空间
const BILI = /^https:\/\/(space|t|www)\.bilibili\.com\//;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id && tab.url && BILI.test(tab.url)) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'blc:toggle' });
      return;
    } catch (_) {
      // 内容脚本还没注入（比如刚安装插件、页面未刷新），退回到新开页
    }
  }
  chrome.tabs.create({ url: 'https://t.bilibili.com/' });
});
