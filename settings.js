'use strict';

/**
 * settings.js
 * GASのPropertiesService(getScriptProperties)の代替として
 * chrome.storage.local に保存・読み込みする。
 * キー名: companyName / nameAndTitle / email
 */

let submitting = false;

// ===========================================
// 起動時：保存済み値をフォームに読み込む
// ===========================================

window.addEventListener('load', function () {
  chrome.storage.local.get(['companyName', 'nameAndTitle', 'email'], function (stored) {
    if (stored.companyName) document.getElementById('companyName').value = stored.companyName;
    if (stored.nameAndTitle) document.getElementById('nameAndTitle').value = stored.nameAndTitle;
    if (stored.email) document.getElementById('email').value = stored.email;
  });

  document.getElementById('companyName').focus();
  setupFormEvents();
});

// ===========================================
// フォームイベント
// ===========================================

function setupFormEvents() {
  const form = document.getElementById('settingsForm');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitting) return;
    handleSave();
  });

  document.getElementById('cancelBtn').addEventListener('click', function () {
    window.close();
  });
}

// ===========================================
// 保存処理
// ===========================================

function handleSave() {
  const companyName = document.getElementById('companyName').value.trim();
  const nameAndTitle = document.getElementById('nameAndTitle').value.trim();
  const email = document.getElementById('email').value.trim();

  // バリデーション（settings.html の GAS版と同じ順序・ルール）
  if (!companyName || !nameAndTitle || !email) {
    showMessage('すべての必須項目を入力してください。', 'error');
    return;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    showMessage('有効なメールアドレスを入力してください。', 'error');
    return;
  }

  submitting = true;
  showLoading(true);

  chrome.storage.local.set({ companyName, nameAndTitle, email }, function () {
    showLoading(false);
    submitting = false;

    if (chrome.runtime.lastError) {
      showMessage('保存中にエラーが発生しました: ' + chrome.runtime.lastError.message, 'error');
      return;
    }

    showMessage('設定を保存しました。', 'success');
    setTimeout(function () {
      window.close();
    }, 2000);
  });
}

// ===========================================
// UI ヘルパー
// ===========================================

function showLoading(show) {
  const loading = document.getElementById('loading');
  const saveBtn = document.getElementById('saveBtn');
  if (show) {
    loading.style.display = 'block';
    saveBtn.disabled = true;
  } else {
    loading.style.display = 'none';
    saveBtn.disabled = false;
  }
}

function showMessage(text, type) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
  if (type === 'success') {
    setTimeout(function () {
      el.style.display = 'none';
    }, 5000);
  }
}
