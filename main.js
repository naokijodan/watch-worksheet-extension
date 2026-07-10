'use strict';

/**
 * main.js
 * - chrome.storage.local から設定を読み込み
 * - フォーム送信 → worksheet.js のロジックを呼び出し
 * - populateTable() で39行HTMLテーブルを組み立て
 * - 印刷ボタン → window.print()
 */

// ===========================================
// 起動時処理
// ===========================================

window.addEventListener('load', function () {
  document.getElementById('awbNumber').focus();
  setupFormEvents();
  setupActionEvents();
});

// ===========================================
// フォームイベント
// ===========================================

function setupFormEvents() {
  const form = document.getElementById('worksheetForm');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    handleCreate();
  });

  // textarea 自動リサイズ
  document.getElementById('chatgptData').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.max(300, this.scrollHeight) + 'px';
  });

  // Ctrl/Cmd + Enter で送信
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      form.dispatchEvent(new Event('submit'));
    }
  });
}

function setupActionEvents() {
  document.getElementById('printBtn').addEventListener('click', function () {
    window.print();
  });

  document.getElementById('backBtn').addEventListener('click', function () {
    showInputSection();
  });
}

// ===========================================
// 作成処理
// ===========================================

function handleCreate() {
  const awbNumber = document.getElementById('awbNumber').value.trim();
  const chatgptData = document.getElementById('chatgptData').value.trim();

  // バリデーション（input.html と同じ順序・メッセージ）
  if (!awbNumber) {
    showMessage('AWB Numberを入力してください。', 'error');
    return;
  }
  if (!chatgptData) {
    showMessage('ChatGPTデータを入力してください。', 'error');
    return;
  }
  if (
    !chatgptData.includes('=== WATCH WORKSHEET DATA ===') ||
    !chatgptData.includes('=== END DATA ===')
  ) {
    showMessage(
      'ChatGPTデータの形式が正しくありません。\n「=== WATCH WORKSHEET DATA ===」から「=== END DATA ===」までの部分が必要です。',
      'error'
    );
    return;
  }

  showLoading(true);
  hideMessage();

  // chrome.storage.local から設定を読み込んでから処理
  chrome.storage.local.get(['companyName', 'nameAndTitle', 'email'], function (stored) {
    const config = {
      companyName: stored.companyName || '',
      nameAndTitle: stored.nameAndTitle || '',
      email: stored.email || ''
    };

    const result = createWatchWorksheetData(awbNumber, chatgptData, config);

    showLoading(false);

    if (!result.success) {
      showMessage(result.message, 'error');
      return;
    }

    renderWorksheet(result.data);
    showWorksheetResult();
  });
}

// ===========================================
// ワークシートテーブル生成
// ===========================================

/**
 * Code.gs の createNewFormatTemplate / populateNewFormatData / formatNewFormatWorksheet
 * が作る39行レイアウトを HTMLテーブルで再現する。
 * 行番号・ラベル・値・背景色はスプレッドシート版と1対1で対応している。
 *
 * 行構成（スプレッドシート行番号との対応）:
 *   row 1  … タイトル（Watch Worksheet）
 *   row 2  … ヘッダー（Watch 1）
 *   row 3  … Style name/No/Reference
 *   row 4  … Style of watch
 *   row 5  …   If Other, provide type
 *   row 6  … Quantity
 *   row 7  … HTSUS Number (if known) [1]
 *   row 8  … HTSUS Number (if known) [2]
 *   row 9  … HTSUS Number (if known) [3]
 *   row 10 … HTSUS Number (if known) [4]
 *   row 11 … What is the primary function of watch
 *   row 12 …   If Other, provide primary function
 *   row 13 … How is the watch powered
 *   row 14 … Country of Origin of the battery
 *   row 15 … Movement/ Display type
 *   row 16 … Is the movement's size over 12mm...
 *   row 17 … Number of Jewels in Movement
 *   row 18 … Country of Origin of Movement
 *   row 19 … Material of Band (Strap)
 *   row 20 …   If Leather, provide type of animal
 *   row 21 …   If Metal, provide type of metal
 *   row 22 …   If Other, provide material
 *   row 23 … Country of Origin of Band (Strap)
 *   row 24 … Material of Case
 *   row 25 …   If Other, provide material
 *   row 26 … Country of Origin of Case
 *   row 27 … Material of Backplate
 *   row 28 …   If Other, provide material
 *   row 29 … Value Breakout (amount and currency)   ← 黄色セクション開始
 *   row 30 …   Movement
 *   row 31 …   Case
 *   row 32 …   Strap
 *   row 33 …   Battery
 *   row 34 …   Total Watch Value
 *   row 35 … （空行）
 *   row 36 … Company Name                           ← 青セクション開始
 *   row 37 … Name and Title
 *   row 38 … E-mail
 *   row 39 … AWB Number
 */
function renderWorksheet(data) {
  const table = document.getElementById('worksheetTable');
  table.innerHTML = '';

  // データ値を populateNewFormatData と同じロジックで計算
  const values = computeCellValues(data);

  // 行定義: [label, value, labelClass, isValueBreakout, isCompany]
  // labelClass: 'ws-label' | 'ws-label-sub'
  const rows = buildRowDefinitions(values);

  // row 1: タイトル
  {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = 'Watch Worksheet';
    td.className = 'ws-title';
    tr.appendChild(td);
    table.appendChild(tr);
  }

  // row 2: ヘッダー
  {
    const tr = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.textContent = '';
    tdLabel.className = 'ws-header';
    const tdValue = document.createElement('td');
    tdValue.textContent = 'Watch 1';
    tdValue.className = 'ws-header';
    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    table.appendChild(tr);
  }

  // row 3～39
  for (const rowDef of rows) {
    const tr = document.createElement('tr');

    if (rowDef.isValueBreakout) tr.classList.add('ws-value-breakout');
    if (rowDef.isCompany) tr.classList.add('ws-company');

    const tdLabel = document.createElement('td');
    tdLabel.textContent = rowDef.label;
    tdLabel.className = rowDef.labelClass;

    const tdValue = document.createElement('td');
    tdValue.textContent = rowDef.value;
    tdValue.className = 'ws-data';

    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    table.appendChild(tr);
  }
}

/**
 * populateNewFormatData と同じロジックでセルの値を決定する。
 * 行番号→値 のマップを返す（行3〜39）。
 */
function computeCellValues(data) {
  const v = {};
  const col = {}; // col[rowNum] = 値

  // 行3
  col[3] = data.styleRef || '';

  // 行4
  col[4] = 'Wrist';

  // 行5 （通常空）
  col[5] = '';

  // 行6
  col[6] = String(data.quantity || 1);

  // 行7
  const htsNumeric = (data.htsCode || '').replace(/\./g, '');
  col[7] = htsNumeric;
  col[8] = '';
  col[9] = '';
  col[10] = '';

  // 行11 / 12: primaryFunction
  const knownFunctions = ['Timekeeping', 'GPS', 'Heart Monitor', 'Wi-Fi', 'Pedometer'];
  if (data.primaryFunction && !knownFunctions.includes(data.primaryFunction)) {
    col[11] = 'Other';
    col[12] = data.primaryFunction;
  } else {
    col[11] = data.primaryFunction || 'Timekeeping';
    col[12] = '';
  }

  // 行13: 動力
  const isQuartz = String(data.movementType).toLowerCase().includes('quartz');
  const isAutomatic = String(data.movementType).toLowerCase().includes('automatic');
  if (isQuartz) {
    col[13] = 'Electric (Battery)';
  } else if (isAutomatic) {
    col[13] = 'Automatic Winding (Self Winding)';
  } else {
    col[13] = 'Manual';
  }

  // 行14: バッテリー産地
  if (isQuartz) {
    col[14] = data.batteryCountry || 'Japan';
  } else {
    col[14] = 'N/A';
  }

  // 行15: Movement/Display type
  col[15] = (data.movementType || '') + ', ' + (data.displayType || 'Analog');

  // 行16
  col[16] = 'No';

  // 行17
  col[17] = String(data.jewelCount || 0);

  // 行18
  col[18] = data.movementCountry || '';

  // 行19〜22: バンド
  col[19] = data.bandMaterial || '';
  col[20] = '';
  col[21] = '';
  col[22] = '';
  if (data.bandMaterial === 'Leather' && data.bandDetail) {
    col[20] = data.bandDetail;
  }
  if (data.bandMaterial === 'Metal' && data.bandDetail) {
    col[21] = data.bandDetail;
  }
  const knownBands = ['Textile', 'Metal', 'Leather', 'No Band'];
  if (data.bandMaterial && !knownBands.includes(data.bandMaterial)) {
    col[22] = data.bandMaterial;
    col[19] = 'Other';
  }

  // 行23
  col[23] = data.bandCountry || '';

  // 行24: ケース素材
  if (data.caseDetail) {
    const detailLower = String(data.caseDetail).toLowerCase();
    if (
      detailLower.includes('plated') ||
      detailLower.includes('gold') ||
      detailLower.includes('silver') ||
      detailLower.includes('precious')
    ) {
      col[24] = data.caseDetail;
    } else {
      col[24] = data.caseDetail + ', ' + (data.caseMaterial || '');
    }
  } else {
    col[24] = data.caseMaterial || '';
  }

  // 行25 (通常空)
  col[25] = '';

  // 行26
  col[26] = data.caseCountry || '';

  // 行27: バックプレート
  if (data.backplateDetail) {
    col[27] = data.backplateDetail;
  } else {
    col[27] = data.backplateMaterial || '';
  }

  // 行28 (通常空)
  col[28] = '';

  // 行29〜34: Value Breakout
  const currency = data.currency || 'USD';
  col[29] = ''; // ラベルのみ
  col[30] = data.movementValue ? data.movementValue.toFixed(2) + ' ' + currency : '';
  col[31] = data.caseValue ? data.caseValue.toFixed(2) + ' ' + currency : '';
  col[32] = data.strapValue ? data.strapValue.toFixed(2) + ' ' + currency : '';
  col[33] = data.batteryValue ? data.batteryValue.toFixed(2) + ' ' + currency : '';
  col[34] = data.totalValue ? data.totalValue.toFixed(2) + ' ' + currency : '';

  // 行35 (空)
  col[35] = '';

  // 行36〜39: Company info
  col[36] = data.companyName || '';
  col[37] = data.nameAndTitle || '';
  col[38] = data.email || '';
  col[39] = data.awbNumber || '';

  return col;
}

/**
 * 行定義の配列を返す（row 3〜39）。
 * label / value / labelClass / isValueBreakout / isCompany
 */
function buildRowDefinitions(col) {
  // labels は createNewFormatTemplate の labels 配列と完全一致
  const labels = [
    'Style name/No/Reference',                                          // row 3
    'Style of watch',                                                   // row 4
    '  If Other, provide type',                                         // row 5
    'Quantity',                                                         // row 6
    'HTSUS Number (if known)',                                          // row 7
    'HTSUS Number (if known)',                                          // row 8
    'HTSUS Number (if known)',                                          // row 9
    'HTSUS Number (if known)',                                          // row 10
    'What is the primary function of watch',                            // row 11
    '  If Other, provide primary function',                             // row 12
    'How is the watch powered',                                         // row 13
    'Country of Origin of the battery',                                 // row 14
    'Movement/ Display type',                                           // row 15
    "Is the movement's size over 12mm in thickness and 50mm in width, length, or diameter?", // row 16
    'Number of Jewels in Movement',                                     // row 17
    'Country of Origin of Movement',                                    // row 18
    'Material of Band (Strap)',                                         // row 19
    '  If Leather, provide type of animal',                             // row 20
    '  If Metal, provide type of metal',                                // row 21
    '  If Other, provide material',                                     // row 22
    'Country of Origin of Band (Strap)',                                // row 23
    'Material of Case',                                                 // row 24
    '  If Other, provide material',                                     // row 25
    'Country of Origin of Case',                                        // row 26
    'Material of Backplate',                                            // row 27
    '  If Other, provide material',                                     // row 28
    'Value Breakout (amount and currency)',                              // row 29
    '  Movement',                                                       // row 30
    '  Case',                                                           // row 31
    '  Strap',                                                          // row 32
    '  Battery',                                                        // row 33
    '  Total Watch Value',                                              // row 34
    '',                                                                 // row 35
    'Company Name',                                                     // row 36
    'Name and Title',                                                   // row 37
    'E-mail',                                                           // row 38
    'AWB Number'                                                        // row 39
  ];

  // Value Breakout: rows 29〜34
  const valueBreakoutRows = new Set([29, 30, 31, 32, 33, 34]);
  // Company: rows 36〜39
  const companyRows = new Set([36, 37, 38, 39]);

  const result = [];
  for (let i = 0; i < labels.length; i++) {
    const rowNum = i + 3; // row 3 が index 0
    const label = labels[i];
    const isSub = label.startsWith('  ');
    result.push({
      label: label,
      value: col[rowNum] || '',
      labelClass: isSub ? 'ws-label-sub' : 'ws-label',
      isValueBreakout: valueBreakoutRows.has(rowNum),
      isCompany: companyRows.has(rowNum)
    });
  }
  return result;
}

// ===========================================
// UI 切り替え
// ===========================================

function showWorksheetResult() {
  document.getElementById('inputSection').style.display = 'none';
  document.getElementById('worksheetResult').style.display = 'block';
  document.getElementById('worksheetResult').scrollIntoView({ behavior: 'smooth' });
}

function showInputSection() {
  document.getElementById('worksheetResult').style.display = 'none';
  document.getElementById('inputSection').style.display = 'block';
  document.getElementById('awbNumber').focus();
}

function showLoading(show) {
  const loading = document.getElementById('loading');
  const createBtn = document.getElementById('createBtn');
  const form = document.getElementById('worksheetForm');
  if (show) {
    loading.style.display = 'block';
    createBtn.disabled = true;
    form.style.opacity = '0.6';
  } else {
    loading.style.display = 'none';
    createBtn.disabled = false;
    form.style.opacity = '1';
  }
}

function showMessage(text, type) {
  const el = document.getElementById('message');
  el.innerHTML = text.replace(/\n/g, '<br>');
  el.className = 'message ' + type;
  el.style.display = 'block';
  if (type === 'error') {
    setTimeout(() => { el.style.display = 'none'; }, 10000);
  }
}

function hideMessage() {
  const el = document.getElementById('message');
  el.style.display = 'none';
}
