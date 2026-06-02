'use strict';

/**
 * panel.js
 * - 入力セクション: ChatGPT貼り付けモード / 直接入力モードの切り替え
 * - 設定セクション: 会社情報をchrome.storage.localに保存
 * - 確認ウィザード: 7ブロックを順番に確認・編集
 * - 印刷: 別ウィンドウを開いてそこでwindow.print()する方式
 *
 * セキュリティ: showMessage等でuserInputをinnerHTMLに流さない。
 * すべてtextContentまたはDOM操作で処理する。
 */

// ===========================================
// グローバル状態
// ===========================================

/** worksheet.js の createWatchWorksheetData / buildDirectData が返したデータ（正規化済み） */
let gData = null;

/** ウィザードで確認・編集されたセルの値（行番号→値の文字列マップ） */
let gCells = {};

/** 全7ブロックを通過したか */
let gAllBlocksDone = false;

// ===========================================
// 起動時処理
// ===========================================

window.addEventListener('load', function () {
  setupInputSection();
  setupSettingsSection();
  setupWizardSection();
  setupPrintSection();
});

// ===========================================
// セクション切り替え
// ===========================================

function showSection(id) {
  const sections = ['sectionInput', 'sectionSettings', 'sectionWizard', 'sectionPrint'];
  sections.forEach(function (s) {
    const el = document.getElementById(s);
    if (el) el.style.display = (s === id) ? '' : 'none';
  });
}

// ===========================================
// 入力セクション — タブ切り替え
// ===========================================

function setupInputSection() {
  // タブ切り替え
  document.getElementById('tabPaste').addEventListener('click', function () {
    switchInputMode('paste');
  });
  document.getElementById('tabDirect').addEventListener('click', function () {
    switchInputMode('direct');
  });

  // ChatGPT貼り付けフォーム
  const form = document.getElementById('worksheetForm');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    handleCreate();
  });

  // Ctrl/Cmd + Enter で送信（貼り付けモード時のみ）
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const inputSection = document.getElementById('sectionInput');
      if (inputSection && inputSection.style.display !== 'none') {
        const modePaste = document.getElementById('modePaste');
        if (modePaste && modePaste.style.display !== 'none') {
          form.dispatchEvent(new Event('submit'));
        }
      }
    }
  });

  // 設定リンク
  document.getElementById('openSettingsLink').addEventListener('click', function () {
    loadSettingsIntoForm();
    showSection('sectionSettings');
  });

  // 直接入力フォームのセットアップ
  setupDirectForm();
}

function switchInputMode(mode) {
  const tabPaste  = document.getElementById('tabPaste');
  const tabDirect = document.getElementById('tabDirect');
  const modePaste = document.getElementById('modePaste');
  const modeDirect = document.getElementById('modeDirect');

  if (mode === 'paste') {
    tabPaste.classList.add('tab-active');
    tabDirect.classList.remove('tab-active');
    tabPaste.setAttribute('aria-selected', 'true');
    tabDirect.setAttribute('aria-selected', 'false');
    modePaste.style.display = '';
    modeDirect.style.display = 'none';
  } else {
    tabPaste.classList.remove('tab-active');
    tabDirect.classList.add('tab-active');
    tabPaste.setAttribute('aria-selected', 'false');
    tabDirect.setAttribute('aria-selected', 'true');
    modePaste.style.display = 'none';
    modeDirect.style.display = '';
  }
}

// ===========================================
// 入力セクション — ChatGPT貼り付けモード
// ===========================================

function handleCreate() {
  const chatgptData = document.getElementById('chatgptData').value.trim();

  if (!chatgptData) {
    showInputMessage('ChatGPTデータを入力してください。', 'error');
    return;
  }
  if (
    !chatgptData.includes('=== WATCH WORKSHEET DATA ===') ||
    !chatgptData.includes('=== END DATA ===')
  ) {
    showInputMessage(
      'ChatGPTデータの形式が正しくありません。\n「=== WATCH WORKSHEET DATA ===」から「=== END DATA ===」までの部分が必要です。',
      'error'
    );
    return;
  }

  setInputLoading(true);
  hideInputMessage();

  chrome.storage.local.get(['companyName', 'nameAndTitle', 'email'], function (stored) {
    const config = {
      companyName: stored.companyName || '',
      nameAndTitle: stored.nameAndTitle || '',
      email: stored.email || ''
    };

    const result = createWatchWorksheetData('', chatgptData, config);

    setInputLoading(false);

    if (!result.success) {
      showInputMessage(result.message, 'error');
      return;
    }

    gData = result.data;
    gAllBlocksDone = false;
    gCells = {};

    initWizard(gData);
    showSection('sectionWizard');
  });
}

function setInputLoading(show) {
  const loading = document.getElementById('inputLoading');
  const btn = document.getElementById('createBtn');
  loading.style.display = show ? 'block' : 'none';
  btn.disabled = show;
}

function showInputMessage(text, type) {
  const el = document.getElementById('inputMessage');
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
  if (type === 'error') {
    setTimeout(function () {
      el.style.display = 'none';
    }, 12000);
  }
}

function hideInputMessage() {
  const el = document.getElementById('inputMessage');
  el.style.display = 'none';
}

// ===========================================
// 直接入力フォーム
// ===========================================

function setupDirectForm() {
  // ムーブメント変更時: Jewels表示制御、バッテリー国自動設定
  document.getElementById('di_movementType').addEventListener('change', function () {
    onDirectMovementChange();
    updateHtsHint();
  });

  // ケース素材変更時: HTSUS候補再計算
  document.getElementById('di_caseMaterial').addEventListener('change', function () {
    updateHtsHint();
  });

  // 製造国一括セット
  document.getElementById('di_countryMain').addEventListener('change', function () {
    applyMainCountry();
  });

  // HTSUSコードのリアルタイム形式チェック
  document.getElementById('di_htsCode').addEventListener('input', function () {
    validateHtsFormat(this.value);
  });

  // タイトル自動生成ボタン
  document.getElementById('di_genTitleBtn').addEventListener('click', function () {
    generateDirectTitle();
  });

  // フォームサブミット
  document.getElementById('directForm').addEventListener('submit', function (e) {
    e.preventDefault();
    handleDirectCreate();
  });

  // 初期化
  onDirectMovementChange();
  updateHtsHint();
}

/** ムーブメント変更時の副作用 */
function onDirectMovementChange() {
  const mt = document.getElementById('di_movementType').value;
  const isQuartz = (mt === 'Quartz');
  const jewelsGroup = document.getElementById('di_jewelsGroup');
  const jewelsNote = document.getElementById('di_jewelsNote');
  const batterySel = document.getElementById('di_batteryCountry');

  // Jewelsフィールドの表示制御
  if (jewelsGroup) {
    jewelsGroup.style.opacity = isQuartz ? '0.5' : '1';
  }
  if (jewelsNote) {
    jewelsNote.style.display = isQuartz ? 'block' : 'none';
  }

  // バッテリー原産国の自動設定
  if (batterySel) {
    batterySel.value = isQuartz ? 'Japan' : 'N/A';
  }
}

/** 製造国一括セット */
function applyMainCountry() {
  const country = document.getElementById('di_countryMain').value;
  if (!country) return;

  const partSelIds = ['di_movementCountry', 'di_caseCountry', 'di_bandCountry'];
  partSelIds.forEach(function (id) {
    const sel = document.getElementById(id);
    if (sel) sel.value = country;
  });

  // バッテリーはムーブメント種別に依存
  const mt = document.getElementById('di_movementType').value;
  const batterySel = document.getElementById('di_batteryCountry');
  if (batterySel) {
    batterySel.value = (mt === 'Quartz') ? 'Japan' : 'N/A';
  }
}

// ===========================================
// HTSUS候補ロジック（G項）
// ===========================================

/**
 * ムーブメント種別 × ケース素材（貴金属か否か）から候補を提示。
 * ルール5の代表コード3つのみ。網羅的分類はしない。
 */
function getHtsCandidates(movementType, caseMaterial) {
  const isQuartz     = (movementType === 'Quartz');
  const isPrecious   = (caseMaterial === 'Wholly of Precious Metal');
  const isMechanical = (movementType === 'Automatic' || movementType === 'Manual');

  const candidates = [];

  if (isQuartz && !isPrecious) {
    candidates.push({ code: '9102.21.5040', desc: '腕時計 / クオーツ / 非貴金属ケース' });
  } else if (isMechanical && !isPrecious) {
    candidates.push({ code: '9102.21.7010', desc: '腕時計 / 機械式 / 非貴金属ケース' });
  } else if (isMechanical && isPrecious) {
    candidates.push({ code: '9102.11.9500', desc: '腕時計 / 機械式 / 貴金属ケース' });
  }

  return candidates;
}

function updateHtsHint() {
  const mt  = document.getElementById('di_movementType').value;
  const cm  = document.getElementById('di_caseMaterial').value;
  const hint = document.getElementById('di_htsHint');
  if (!hint) return;

  const candidates = getHtsCandidates(mt, cm);

  if (candidates.length === 0) {
    hint.textContent = '候補なし: 正しいコードを手入力してください。';
    hint.className = 'hts-hint hts-hint-warn';
    return;
  }

  hint.className = 'hts-hint hts-hint-info';
  hint.innerHTML = '';

  const label = document.createElement('strong');
  label.textContent = '候補コード（参考のみ）: ';
  hint.appendChild(label);

  candidates.forEach(function (c, i) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hts-candidate-btn';
    btn.textContent = c.code + ' — ' + c.desc;
    btn.addEventListener('click', function () {
      document.getElementById('di_htsCode').value = c.code;
      validateHtsFormat(c.code);
    });
    hint.appendChild(btn);
    if (i < candidates.length - 1) {
      hint.appendChild(document.createElement('br'));
    }
  });
}

/**
 * 10桁形式チェック: ####.##.#### の形式か確認。
 */
function validateHtsFormat(val) {
  const errEl = document.getElementById('di_htsError');
  if (!errEl) return;
  const trimmed = val.trim();
  if (!trimmed) {
    errEl.style.display = 'none';
    return;
  }
  // 形式: 4桁.2桁.4桁 = 10桁数字 + 2ドット
  const ok = /^\d{4}\.\d{2}\.\d{4}$/.test(trimmed);
  if (!ok) {
    errEl.textContent = '形式が正しくありません。例: 9102.21.5040 (10桁・ドット区切り)';
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }
}

// ===========================================
// タイトル自動生成（D項 — ルール11準拠）
// ===========================================

function generateDirectTitle() {
  const brand    = document.getElementById('di_brand').value.trim();
  const ref      = document.getElementById('di_reference').value.trim();
  const mt       = document.getElementById('di_movementType').value;
  const caseDet  = document.getElementById('di_caseDetail').value.trim();
  const bandMat  = document.getElementById('di_bandMaterial').value;
  const jewels   = parseInt(document.getElementById('di_jewelCount').value || '0', 10);

  if (!brand && !ref) {
    showDirectMessage('タイトル生成にはブランドか型番が必要です。', 'error');
    return;
  }

  if (!caseDet) {
    showDirectMessage('ケース素材（詳細）が未入力です。入力するとタイトルに反映されます。', 'warn');
  }

  const parts = [];

  if (brand) parts.push(brand);
  if (ref)   parts.push(ref);

  // Movement
  parts.push(mt);

  // Jewels: 機械式のみ (数値+J)
  if (mt !== 'Quartz' && jewels > 0) {
    parts.push(jewels + 'J');
  }

  // Case Material (詳細優先)
  if (caseDet) parts.push(caseDet);

  // Band Material
  if (bandMat && bandMat !== 'No Band') {
    parts.push(bandMat + ' Band');
  }

  parts.push('Watch');

  const title = parts.join(' ');

  const styleRefEl = document.getElementById('di_styleRef');
  styleRefEl.value = title;

  const previewEl = document.getElementById('di_titlePreview');
  if (previewEl) {
    previewEl.textContent = '生成済み: ' + title;
    previewEl.style.display = 'block';
  }
}

// ===========================================
// 直接入力 → normalizeData 形式へ変換
// ===========================================

/**
 * 直接入力フォームの値を、normalizeData の出力オブジェクトと同じ形式に組み立てる。
 * worksheet.js の calculateValueBreakout / mapJewelsToDropdown を再利用する。
 */
function buildDirectData(config) {
  const mt       = document.getElementById('di_movementType').value;
  const isQuartz = (mt === 'Quartz');

  const priceRaw = parseFloat(document.getElementById('di_price').value || '0');
  const currency = document.getElementById('di_currency').value || 'USD';
  const jewCount = parseInt(document.getElementById('di_jewelCount').value || '0', 10);

  const styleRef = document.getElementById('di_styleRef').value.trim();
  const htsRaw   = document.getElementById('di_htsCode').value.trim();

  // Value Breakout
  const breakout = calculateValueBreakout(priceRaw, mt);

  const data = {
    styleRef:         styleRef,
    totalValue:       priceRaw,
    currency:         currency,
    movementType:     mt,
    displayType:      document.getElementById('di_displayType').value,
    htsCode:          htsRaw.replace(/\./g, ''),   // ドットなし数字列で保持（buildFinalCellsと整合）
    jewels:           isQuartz ? '0 to 1 Jewels' : mapJewelsToDropdown(jewCount),
    jewelCount:       isQuartz ? 0 : jewCount,
    quantity:         parseInt(document.getElementById('di_quantity').value || '1', 10),

    bandMaterial:     document.getElementById('di_bandMaterial').value,
    bandDetail:       document.getElementById('di_bandDetail').value.trim(),
    caseMaterial:     document.getElementById('di_caseMaterial').value,
    caseDetail:       document.getElementById('di_caseDetail').value.trim(),
    backplateMaterial: document.getElementById('di_backplateMaterial').value,
    backplateDetail:  document.getElementById('di_backplateDetail').value.trim(),

    movementCountry:  document.getElementById('di_movementCountry').value,
    caseCountry:      document.getElementById('di_caseCountry').value,
    bandCountry:      document.getElementById('di_bandCountry').value,
    batteryCountry:   document.getElementById('di_batteryCountry').value,
    // backplateCountry はワークシートに項目がないため収集しない

    primaryFunction:  document.getElementById('di_primaryFunction').value,
    otherMaterials:   '',

    movementValue:    breakout.movement,
    caseValue:        breakout.case,
    strapValue:       breakout.strap,
    batteryValue:     breakout.battery,

    companyName:      (config || {}).companyName || '',
    nameAndTitle:     (config || {}).nameAndTitle || '',
    email:            (config || {}).email || '',
    awbNumber:        ''
  };

  // over12mm はウィザードB4（f_over12mm）に直接セットする
  data._over12mm = document.getElementById('di_over12mm').value;

  return data;
}

/**
 * 直接入力フォームの送信処理。
 * バリデーション → buildDirectData → initWizard の順で流す。
 */
function handleDirectCreate() {
  // バリデーション
  const brand   = document.getElementById('di_brand').value.trim();
  const ref     = document.getElementById('di_reference').value.trim();
  const price   = document.getElementById('di_price').value.trim();
  const styleRef = document.getElementById('di_styleRef').value.trim();

  if (!brand && !ref) {
    showDirectMessage('ブランドまたは型番を入力してください。', 'error');
    return;
  }
  if (!price || parseFloat(price) <= 0) {
    showDirectMessage('販売価格を正しく入力してください。', 'error');
    return;
  }
  if (!styleRef) {
    showDirectMessage('Style name/No/Reference が空です。「タイトルを生成」ボタンを押すか手入力してください。', 'error');
    return;
  }

  // HTSUS形式チェック（入力されている場合のみ）
  const htsVal = document.getElementById('di_htsCode').value.trim();
  if (htsVal && !/^\d{4}\.\d{2}\.\d{4}$/.test(htsVal)) {
    showDirectMessage('HTSUSコードの形式が正しくありません。例: 9102.21.5040', 'error');
    return;
  }

  chrome.storage.local.get(['companyName', 'nameAndTitle', 'email'], function (stored) {
    const config = {
      companyName: stored.companyName || '',
      nameAndTitle: stored.nameAndTitle || '',
      email: stored.email || ''
    };

    const data = buildDirectData(config);

    gData = data;
    gAllBlocksDone = false;
    gCells = {};

    initWizard(gData);
    showSection('sectionWizard');
  });
}

function showDirectMessage(text, type) {
  const el = document.getElementById('directInputMessage');
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
  if (type === 'error' || type === 'warn') {
    setTimeout(function () {
      el.style.display = 'none';
    }, 10000);
  }
}

// ===========================================
// 設定セクション
// ===========================================

function setupSettingsSection() {
  document.getElementById('backToInputFromSettings').addEventListener('click', function () {
    showSection('sectionInput');
  });

  document.getElementById('cancelSettingsBtn').addEventListener('click', function () {
    showSection('sectionInput');
  });

  document.getElementById('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    handleSaveSettings();
  });
}

function loadSettingsIntoForm() {
  chrome.storage.local.get(['companyName', 'nameAndTitle', 'email'], function (stored) {
    if (stored.companyName) document.getElementById('companyName').value = stored.companyName;
    if (stored.nameAndTitle) document.getElementById('nameAndTitle').value = stored.nameAndTitle;
    if (stored.email) document.getElementById('email').value = stored.email;
  });
}

function handleSaveSettings() {
  const companyName = document.getElementById('companyName').value.trim();
  const nameAndTitle = document.getElementById('nameAndTitle').value.trim();
  const email = document.getElementById('email').value.trim();

  if (!companyName || !nameAndTitle || !email) {
    showSettingsMessage('すべての必須項目を入力してください。', 'error');
    return;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    showSettingsMessage('有効なメールアドレスを入力してください。', 'error');
    return;
  }

  const saveBtn = document.getElementById('saveSettingsBtn');
  const loading = document.getElementById('settingsLoading');
  saveBtn.disabled = true;
  loading.style.display = 'block';

  chrome.storage.local.set({ companyName, nameAndTitle, email }, function () {
    loading.style.display = 'none';
    saveBtn.disabled = false;

    if (chrome.runtime.lastError) {
      showSettingsMessage('保存中にエラーが発生しました: ' + chrome.runtime.lastError.message, 'error');
      return;
    }

    showSettingsMessage('設定を保存しました。', 'success');
    setTimeout(function () {
      showSection('sectionInput');
    }, 1500);
  });
}

function showSettingsMessage(text, type) {
  const el = document.getElementById('settingsMessage');
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
}

// ===========================================
// 確認ウィザード
// ===========================================

/**
 * ウィザード用フィールド定義。
 * blockId: 1〜7
 * fieldId: HTMLのinput id
 * rowNum: スプレッドシート行番号（参考情報・gCells のキー）
 * getInitial(data): gDataから初期値を取り出す関数
 */
const WIZARD_FIELDS = [
  // Block 1
  { blockId: 1, fieldId: 'f_styleRef',       rowNum: 3,  getInitial: function(d){ return d.styleRef || ''; } },
  { blockId: 1, fieldId: 'f_styleOfWatch',   rowNum: 4,  getInitial: function()  { return 'Wrist'; } },
  { blockId: 1, fieldId: 'f_styleOther',     rowNum: 5,  getInitial: function()  { return ''; } },
  { blockId: 1, fieldId: 'f_quantity',       rowNum: 6,  getInitial: function(d){ return String(d.quantity || 1); } },
  // Block 2
  { blockId: 2, fieldId: 'f_hts1',           rowNum: 7,  getInitial: function(d){ return (d.htsCode || '').replace(/\./g, ''); } },
  { blockId: 2, fieldId: 'f_hts2',           rowNum: 8,  getInitial: function()  { return ''; } },
  { blockId: 2, fieldId: 'f_hts3',           rowNum: 9,  getInitial: function()  { return ''; } },
  { blockId: 2, fieldId: 'f_hts4',           rowNum: 10, getInitial: function()  { return ''; } },
  // Block 3
  { blockId: 3, fieldId: 'f_primaryFunc',    rowNum: 11, getInitial: function(d){
      const known = ['Timekeeping','GPS','Heart Monitor','Wi-Fi','Pedometer'];
      return (d.primaryFunction && !known.includes(d.primaryFunction)) ? 'Other' : (d.primaryFunction || 'Timekeeping');
    }
  },
  { blockId: 3, fieldId: 'f_primaryFuncOther', rowNum: 12, getInitial: function(d){
      const known = ['Timekeeping','GPS','Heart Monitor','Wi-Fi','Pedometer'];
      return (d.primaryFunction && !known.includes(d.primaryFunction)) ? d.primaryFunction : '';
    }
  },
  { blockId: 3, fieldId: 'f_powered',        rowNum: 13, getInitial: function(d){
      const mt = String(d.movementType || '').toLowerCase();
      if (mt.includes('quartz')) return 'Electric (Battery)';
      if (mt.includes('automatic')) return 'Automatic Winding (Self Winding)';
      return 'Manual';
    }
  },
  { blockId: 3, fieldId: 'f_batteryOrigin',  rowNum: 14, getInitial: function(d){
      const mt = String(d.movementType || '').toLowerCase();
      return mt.includes('quartz') ? (d.batteryCountry || 'Japan') : 'N/A';
    }
  },
  // Block 4
  { blockId: 4, fieldId: 'f_movementDisplay', rowNum: 15, getInitial: function(d){
      return (d.movementType || '') + ', ' + (d.displayType || 'Analog');
    }
  },
  { blockId: 4, fieldId: 'f_over12mm',       rowNum: 16, getInitial: function(d){
      // 直接入力モードの場合は _over12mm が入っている
      return d._over12mm || 'No';
    }
  },
  { blockId: 4, fieldId: 'f_jewels',         rowNum: 17, getInitial: function(d){ return String(d.jewelCount || 0); } },
  { blockId: 4, fieldId: 'f_movementOrigin', rowNum: 18, getInitial: function(d){ return d.movementCountry || ''; } },
  // Block 5
  { blockId: 5, fieldId: 'f_bandMaterial',   rowNum: 19, getInitial: function(d){
      const known = ['Textile','Metal','Leather','No Band'];
      return (d.bandMaterial && !known.includes(d.bandMaterial)) ? 'Other' : (d.bandMaterial || '');
    }
  },
  { blockId: 5, fieldId: 'f_bandLeather',    rowNum: 20, getInitial: function(d){
      return (d.bandMaterial === 'Leather' && d.bandDetail) ? d.bandDetail : '';
    }
  },
  { blockId: 5, fieldId: 'f_bandMetal',      rowNum: 21, getInitial: function(d){
      return (d.bandMaterial === 'Metal' && d.bandDetail) ? d.bandDetail : '';
    }
  },
  { blockId: 5, fieldId: 'f_bandOther',      rowNum: 22, getInitial: function(d){
      const known = ['Textile','Metal','Leather','No Band'];
      return (d.bandMaterial && !known.includes(d.bandMaterial)) ? d.bandMaterial : '';
    }
  },
  { blockId: 5, fieldId: 'f_bandOrigin',     rowNum: 23, getInitial: function(d){ return d.bandCountry || ''; } },
  { blockId: 5, fieldId: 'f_caseMaterial',   rowNum: 24, getInitial: function(d){
      if (d.caseDetail) {
        const dl = String(d.caseDetail).toLowerCase();
        if (dl.includes('plated')||dl.includes('gold')||dl.includes('silver')||dl.includes('precious')) {
          return d.caseDetail;
        }
        return d.caseDetail + ', ' + (d.caseMaterial || '');
      }
      return d.caseMaterial || '';
    }
  },
  { blockId: 5, fieldId: 'f_caseOther',      rowNum: 25, getInitial: function()  { return ''; } },
  { blockId: 5, fieldId: 'f_caseOrigin',     rowNum: 26, getInitial: function(d){ return d.caseCountry || ''; } },
  { blockId: 5, fieldId: 'f_backplateMaterial', rowNum: 27, getInitial: function(d){
      return d.backplateDetail ? d.backplateDetail : (d.backplateMaterial || '');
    }
  },
  { blockId: 5, fieldId: 'f_backplateOther', rowNum: 28, getInitial: function(d){
      // 直接入力モードでは使用しない（裏蓋原産国はワークシートに項目なし）
      return '';
    }
  },
  // Block 6
  { blockId: 6, fieldId: 'f_movementValue',  rowNum: 30, getInitial: function(d){
      const cur = d.currency || 'USD';
      return d.movementValue ? d.movementValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'f_caseValue',      rowNum: 31, getInitial: function(d){
      const cur = d.currency || 'USD';
      return d.caseValue ? d.caseValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'f_strapValue',     rowNum: 32, getInitial: function(d){
      const cur = d.currency || 'USD';
      return d.strapValue ? d.strapValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'f_batteryValue',   rowNum: 33, getInitial: function(d){
      const cur = d.currency || 'USD';
      return d.batteryValue ? d.batteryValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'f_totalValue',     rowNum: 34, getInitial: function(d){
      const cur = d.currency || 'USD';
      return d.totalValue ? d.totalValue.toFixed(2) + ' ' + cur : '';
    }
  },
  // Block 7
  { blockId: 7, fieldId: 'f_awb',            rowNum: 39, getInitial: function()  { return ''; } },
  { blockId: 7, fieldId: 'f_wiz_companyName', rowNum: 36, getInitial: function(d){ return d.companyName || ''; } },
  { blockId: 7, fieldId: 'f_wiz_nameAndTitle', rowNum: 37, getInitial: function(d){ return d.nameAndTitle || ''; } },
  { blockId: 7, fieldId: 'f_wiz_email',      rowNum: 38, getInitial: function(d){ return d.email || ''; } }
];

const TOTAL_BLOCKS = 7;
/** 各ブロックが通過済みかどうかのフラグ */
const blockDone = {};

function initWizard(data) {
  // 全ブロックのフィールドに初期値を設定
  WIZARD_FIELDS.forEach(function (f) {
    const el = document.getElementById(f.fieldId);
    if (el) el.value = f.getInitial(data);
  });

  // 全ブロックのdone状態をリセット
  for (let i = 1; i <= TOTAL_BLOCKS; i++) blockDone[i] = false;
  gAllBlocksDone = false;
  gCells = {};

  // Block1を表示、他を隠す
  showBlock(1);
  updateProgress();
}

function setupWizardSection() {
  document.getElementById('backToInputFromWizard').addEventListener('click', function () {
    gData = null;
    showSection('sectionInput');
  });

  // 各ブロックの「次へ」「戻る」ボタン
  document.querySelectorAll('.wiz-next').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const blockId = parseInt(this.getAttribute('data-block'), 10);
      collectBlock(blockId);
      blockDone[blockId] = true;
      updateProgress();
      showBlock(blockId + 1);
    });
  });

  document.querySelectorAll('.wiz-prev').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const blockId = parseInt(this.getAttribute('data-block'), 10);
      collectBlock(blockId);
      showBlock(blockId - 1);
    });
  });

  // 「確認完了」ボタン
  document.getElementById('confirmDoneBtn').addEventListener('click', function () {
    collectBlock(7);
    blockDone[7] = true;
    gAllBlocksDone = true;
    updateProgress();
    buildPreviewAndShow();
  });
}

function showBlock(blockId) {
  for (let i = 1; i <= TOTAL_BLOCKS; i++) {
    const el = document.getElementById('block' + i);
    if (el) el.style.display = (i === blockId) ? '' : 'none';
  }
}

function updateProgress() {
  const doneCount = Object.values(blockDone).filter(Boolean).length;
  const el = document.getElementById('wizardProgress');
  if (el) {
    el.textContent = doneCount + ' / ' + TOTAL_BLOCKS + ' 確認済み';
  }
}

/**
 * 指定ブロックのフィールド値を gCells に収集する。
 */
function collectBlock(blockId) {
  WIZARD_FIELDS.filter(function (f) { return f.blockId === blockId; }).forEach(function (f) {
    const el = document.getElementById(f.fieldId);
    if (el) gCells[f.rowNum] = el.value;
  });
}

// ===========================================
// 印刷セクション
// ===========================================

function setupPrintSection() {
  document.getElementById('backToWizardBtn').addEventListener('click', function () {
    showSection('sectionWizard');
    showBlock(7);
  });

  document.getElementById('backToInputFinalBtn').addEventListener('click', function () {
    gData = null;
    gCells = {};
    gAllBlocksDone = false;
    showSection('sectionInput');
  });

  document.getElementById('openPrintWindowBtn').addEventListener('click', function () {
    openPrintWindow();
  });
}

/**
 * ウィザードの gCells を反映した最終39行分のセル値マップを組み立てる。
 */
function buildFinalCells() {
  const col = {};
  const data = gData;

  col[3]  = data.styleRef || '';
  col[4]  = 'Wrist';
  col[5]  = '';
  col[6]  = String(data.quantity || 1);

  const htsNumeric = (data.htsCode || '').replace(/\./g, '');
  col[7]  = htsNumeric;
  col[8]  = '';
  col[9]  = '';
  col[10] = '';

  const known = ['Timekeeping','GPS','Heart Monitor','Wi-Fi','Pedometer'];
  if (data.primaryFunction && !known.includes(data.primaryFunction)) {
    col[11] = 'Other';
    col[12] = data.primaryFunction;
  } else {
    col[11] = data.primaryFunction || 'Timekeeping';
    col[12] = '';
  }

  const mt = String(data.movementType || '').toLowerCase();
  if (mt.includes('quartz'))         col[13] = 'Electric (Battery)';
  else if (mt.includes('automatic')) col[13] = 'Automatic Winding (Self Winding)';
  else                               col[13] = 'Manual';

  col[14] = mt.includes('quartz') ? (data.batteryCountry || 'Japan') : 'N/A';

  col[15] = (data.movementType || '') + ', ' + (data.displayType || 'Analog');
  col[16] = data._over12mm || 'No';
  col[17] = String(data.jewelCount || 0);
  col[18] = data.movementCountry || '';

  const knownBands = ['Textile','Metal','Leather','No Band'];
  if (data.bandMaterial && !knownBands.includes(data.bandMaterial)) {
    col[19] = 'Other';
    col[20] = '';
    col[21] = '';
    col[22] = data.bandMaterial;
  } else {
    col[19] = data.bandMaterial || '';
    col[20] = (data.bandMaterial === 'Leather' && data.bandDetail) ? data.bandDetail : '';
    col[21] = (data.bandMaterial === 'Metal' && data.bandDetail) ? data.bandDetail : '';
    col[22] = '';
  }
  col[23] = data.bandCountry || '';

  if (data.caseDetail) {
    const dl = String(data.caseDetail).toLowerCase();
    if (dl.includes('plated')||dl.includes('gold')||dl.includes('silver')||dl.includes('precious')) {
      col[24] = data.caseDetail;
    } else {
      col[24] = data.caseDetail + ', ' + (data.caseMaterial || '');
    }
  } else {
    col[24] = data.caseMaterial || '';
  }
  col[25] = '';
  col[26] = data.caseCountry || '';
  col[27] = data.backplateDetail ? data.backplateDetail : (data.backplateMaterial || '');
  col[28] = '';

  const currency = data.currency || 'USD';
  col[29] = '';
  col[30] = data.movementValue ? data.movementValue.toFixed(2) + ' ' + currency : '';
  col[31] = data.caseValue     ? data.caseValue.toFixed(2)     + ' ' + currency : '';
  col[32] = data.strapValue    ? data.strapValue.toFixed(2)    + ' ' + currency : '';
  col[33] = data.batteryValue  ? data.batteryValue.toFixed(2)  + ' ' + currency : '';
  col[34] = data.totalValue    ? data.totalValue.toFixed(2)    + ' ' + currency : '';

  col[35] = '';
  col[36] = data.companyName  || '';
  col[37] = data.nameAndTitle || '';
  col[38] = data.email        || '';
  col[39] = '';

  // gCells の値で上書き（ウィザードで編集した値が最終出力に反映）
  Object.keys(gCells).forEach(function (rowNum) {
    col[parseInt(rowNum, 10)] = gCells[rowNum];
  });

  return col;
}

/**
 * ラベル定義
 */
const ROW_LABELS = [
  'Style name/No/Reference',
  'Style of watch',
  '  If Other, provide type',
  'Quantity',
  'HTSUS Number (if known)',
  'HTSUS Number (if known)',
  'HTSUS Number (if known)',
  'HTSUS Number (if known)',
  'What is the primary function of watch',
  '  If Other, provide primary function',
  'How is the watch powered',
  'Country of Origin of the battery',
  'Movement/ Display type',
  "Is the movement's size over 12mm in thickness and 50mm in width, length, or diameter?",
  'Number of Jewels in Movement',
  'Country of Origin of Movement',
  'Material of Band (Strap)',
  '  If Leather, provide type of animal',
  '  If Metal, provide type of metal',
  '  If Other, provide material',
  'Country of Origin of Band (Strap)',
  'Material of Case',
  '  If Other, provide material',
  'Country of Origin of Case',
  'Material of Backplate',
  '  If Other, provide material',
  'Value Breakout (amount and currency)',
  '  Movement',
  '  Case',
  '  Strap',
  '  Battery',
  '  Total Watch Value',
  '',
  'Company Name',
  'Name and Title',
  'E-mail',
  'AWB Number'
];

const VALUE_BREAKOUT_ROWS = new Set([29,30,31,32,33,34]);
const COMPANY_ROWS        = new Set([36,37,38,39]);

function renderTable(tableEl, col) {
  tableEl.innerHTML = '';

  const trTitle = document.createElement('tr');
  const tdTitle = document.createElement('td');
  tdTitle.colSpan = 2;
  tdTitle.textContent = 'Watch Worksheet';
  tdTitle.className = 'ws-title';
  trTitle.appendChild(tdTitle);
  tableEl.appendChild(trTitle);

  const trHeader = document.createElement('tr');
  const tdHLabel = document.createElement('td');
  tdHLabel.textContent = '';
  tdHLabel.className = 'ws-header';
  const tdHValue = document.createElement('td');
  tdHValue.textContent = 'Watch 1';
  tdHValue.className = 'ws-header';
  trHeader.appendChild(tdHLabel);
  trHeader.appendChild(tdHValue);
  tableEl.appendChild(trHeader);

  ROW_LABELS.forEach(function (label, idx) {
    const rowNum = idx + 3;
    const isSub  = label.startsWith('  ');
    const isVB   = VALUE_BREAKOUT_ROWS.has(rowNum);
    const isCo   = COMPANY_ROWS.has(rowNum);

    const tr = document.createElement('tr');
    if (isVB) tr.classList.add('ws-value-breakout');
    if (isCo) tr.classList.add('ws-company');

    const tdLabel = document.createElement('td');
    tdLabel.textContent = label;
    tdLabel.className   = isSub ? 'ws-label-sub' : 'ws-label';

    const tdValue = document.createElement('td');
    tdValue.textContent = col[rowNum] || '';
    tdValue.className   = 'ws-data';

    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    tableEl.appendChild(tr);
  });
}

function buildPreviewAndShow() {
  const col   = buildFinalCells();
  const table = document.getElementById('previewTable');
  renderTable(table, col);
  showSection('sectionPrint');
}

// ===========================================
// 印刷ウィンドウ（別ウィンドウ方式）
// ===========================================

function openPrintWindow() {
  const col     = buildFinalCells();
  const payload = JSON.stringify(col);

  chrome.storage.local.set({ _printPayload: payload }, function () {
    if (chrome.runtime.lastError) {
      const note = document.querySelector('.print-note');
      if (note) {
        const errSpan = document.createElement('span');
        errSpan.style.color = '#b71c1c';
        errSpan.textContent = ' データ保存エラー: ' + chrome.runtime.lastError.message;
        note.appendChild(errSpan);
      }
      return;
    }
    window.open(chrome.runtime.getURL('print.html'), '_blank');
  });
}
