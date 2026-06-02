'use strict';

/**
 * background.js (service worker)
 * ツールバーアイコンをクリックしたとき、サイドパネルを開く。
 * chrome.sidePanel.setPanelBehavior で openPanelOnActionClick を有効にする。
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(function (e) {
    console.error('sidePanel.setPanelBehavior error:', e);
  });
