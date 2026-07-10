'use strict';

document.getElementById('openMainBtn').addEventListener('click', function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('main.html') });
  window.close();
});

document.getElementById('openSettingsBtn').addEventListener('click', function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  window.close();
});
