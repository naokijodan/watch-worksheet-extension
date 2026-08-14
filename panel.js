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

/** OpenAI APIキー（設定から読み込み） */
let gOpenAiKey = '';

/**
 * 複数本（最大5本）まとめて処理するためのリスト。
 * 「＋時計を追加」で確定済みの current watch（gData/gCells）が1件ずつ積まれる。
 * 各要素: { data: <gDataのスナップショット>, cells: <gCellsのスナップショット> }
 * 「現在編集中の1本」は引き続き gData/gCells が保持する（このリストには含めない）。
 */
let gWatchList = [];

/** 登録できる時計の上限本数（current + gWatchList の合計） */
const MAX_WATCHES = 5;

/**
 * 「編集」中の保留状態。editWatchEntry() でリストから取り出した1本を、
 * ウィザードを最後まで終えずに（＝blockDone[7]まで到達せず）中断した場合、
 * この2つを使って元の（未編集の）状態をリストへ安全に戻す。
 *   gEditingListIndex … 編集対象がリストの何番目にあったか（nullなら編集中ではない）
 *   gEditingBackup     … 編集前のオリジナルのスナップショット（half-editedなgData/gCellsではなく、これを戻す）
 * どちらも「編集を最後まで完了した」「新規に別の1本を確定した」「全部リセットした」時点で
 * null に戻す（= もう戻す必要がなくなったことを示す）。
 */
let gEditingListIndex = null;
let gEditingBackup = null;

/** ドット・ハイフン・空白を除去して数字のみのコードにする（HTSUS入力を10桁数字で統一するため） */
function stripDots(s) {
  return (s == null ? '' : String(s)).replace(/[.\-\s]/g, '');
}

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

  // AI読み取りボタン
  document.getElementById('aiAnalyzeBtn').addEventListener('click', startAiFlow);

  // 起動時にAPIキーをロード
  loadSettingsIntoForm();
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

    // 今から新しい current を作る＝今の current を捨てる操作。
    // それが「編集中」の1本だった場合に備え、オリジナルをリストへ戻してから進む。
    restorePendingEditIfAny();
    if (gWatchList.length >= MAX_WATCHES) {
      // sectionInput にはこの後遷移させない＝あちらのメッセージ欄は誰にも見えない。
      // データ（5本のリスト）を見て操作できる画面（リスト/印刷）へ連れ戻し、そこで案内する。
      renderCurrentWatchPreview();
      renderMultiWatchList();
      showSection('sectionPrint');
      showPrintMessage('時計は最大' + MAX_WATCHES + '本です。リストから削除するとまた追加できます。', 'error');
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

  // AI読み取りの不確実フィールド警告（赤枠・点滅・インライン警告）は、
  // ユーザーがそのフィールドに入力・選択した時点で解除する（2026-08-14対応）
  document.getElementById('di_jewelCount').addEventListener('input', function () {
    clearAiFieldWarning('di_jewelCount');
  });
  document.getElementById('di_bandMaterial').addEventListener('change', function () {
    clearAiFieldWarning('di_bandMaterial');
  });

  // 製造国一括セット
  document.getElementById('di_countryMain').addEventListener('change', function () {
    applyMainCountry();
  });

  // HTSUSコードのリアルタイム形式チェック（ドット・ハイフン・空白は自動除去して数字のみに整える）
  document.getElementById('di_htsCode').addEventListener('input', function () {
    const normalized = stripDots(this.value);
    if (normalized !== this.value) {
      this.value = normalized;
    }
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

  // AI読み取り後の「印刷プレビューへ直接進む」ボタン
  const printDirectBtn = document.getElementById('di_printDirectBtn');
  if (printDirectBtn) {
    printDirectBtn.addEventListener('click', function () {
      handleDirectToPreview();
    });
  }

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
    const codeDigits = stripDots(c.code);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hts-candidate-btn';
    btn.textContent = codeDigits + ' — ' + c.desc;
    btn.addEventListener('click', function () {
      document.getElementById('di_htsCode').value = codeDigits;
      validateHtsFormat(codeDigits);
    });
    hint.appendChild(btn);
    if (i < candidates.length - 1) {
      hint.appendChild(document.createElement('br'));
    }
  });
}

/**
 * 10桁形式チェック: ドット・ハイフン・空白を除去した結果が数字10桁か確認。
 */
function validateHtsFormat(val) {
  const errEl = document.getElementById('di_htsError');
  if (!errEl) return;
  const trimmed = val.trim();
  if (!trimmed) {
    errEl.style.display = 'none';
    return;
  }
  // 形式: ドット・ハイフン・空白を除去した結果が10桁の数字
  const ok = /^\d{10}$/.test(stripDots(trimmed));
  if (!ok) {
    errEl.textContent = '形式が正しくありません。10桁の数字で入力してください（例: 9102215040）';
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
    htsCode:          stripDots(htsRaw),   // ドットなし数字列で保持（buildFinalCellsと整合）
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
    awbNumber:        document.getElementById('di_awb').value.trim()
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
  if (htsVal && !/^\d{10}$/.test(stripDots(htsVal))) {
    showDirectMessage('HTSUSコードの形式が正しくありません。10桁の数字で入力してください（例: 9102215040）', 'error');
    return;
  }

  // 今から新しい current を作る＝今の current を捨てる操作。
  // それが「編集中」の1本だった場合に備え、オリジナルをリストへ戻してから進む。
  restorePendingEditIfAny();
  if (gWatchList.length >= MAX_WATCHES) {
    // sectionInput にはこの後遷移させない＝あちらのメッセージ欄は誰にも見えない。
    // データ（5本のリスト）を見て操作できる画面（リスト/印刷）へ連れ戻し、そこで案内する。
    renderCurrentWatchPreview();
    renderMultiWatchList();
    showSection('sectionPrint');
    showPrintMessage('時計は最大' + MAX_WATCHES + '本です。リストから削除するとまた追加できます。', 'error');
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

/**
 * AI読み取り後の「印刷プレビューへ直接進む」処理。
 * バリデーション → confirm → buildDirectData → buildPreviewAndShow
 */
function handleDirectToPreview() {
  const brand    = document.getElementById('di_brand').value.trim();
  const ref      = document.getElementById('di_reference').value.trim();
  const price    = document.getElementById('di_price').value.trim();
  const styleRef = document.getElementById('di_styleRef').value.trim();
  const htsVal   = document.getElementById('di_htsCode').value.trim();

  if (!brand && !ref) {
    showDirectMessage('ブランドまたは型番を入力してください。', 'error');
    return;
  }
  if (!price || parseFloat(price) <= 0) {
    showDirectMessage('申告価格を入力してください（出品価格と異なる場合は正しい申告価格を入力してください）。', 'error');
    return;
  }
  if (!styleRef) {
    showDirectMessage('Style name/No/Reference が空です。「タイトルを生成」ボタンを押すか手入力してください。', 'error');
    return;
  }
  if (!htsVal) {
    showDirectMessage('HTSUSコードを入力してください。', 'error');
    return;
  }
  if (!/^\d{10}$/.test(stripDots(htsVal))) {
    showDirectMessage('HTSUSコードの形式が正しくありません。10桁の数字で入力してください（例: 9102215040）', 'error');
    return;
  }

  // 今から新しい current を作る＝今の current を捨てる操作。
  // それが「編集中」の1本だった場合に備え、オリジナルをリストへ戻してから進む。
  restorePendingEditIfAny();
  if (gWatchList.length >= MAX_WATCHES) {
    // sectionInput にはこの後遷移させない＝あちらのメッセージ欄は誰にも見えない。
    // データ（5本のリスト）を見て操作できる画面（リスト/印刷）へ連れ戻し、そこで案内する。
    renderCurrentWatchPreview();
    renderMultiWatchList();
    showSection('sectionPrint');
    showPrintMessage('時計は最大' + MAX_WATCHES + '本です。リストから削除するとまた追加できます。', 'error');
    return;
  }

  const currency = document.getElementById('di_currency').value || 'USD';
  const confirmed = window.confirm(
    '印刷プレビューに進む前に、以下をすべて確認しましたか？\n\n' +
    '✅ ブランド・型番\n' +
    '✅ ムーブメント種別・素材\n' +
    '✅ 原産国\n' +
    '✅ HTSUSコード\n' +
    '✅ 申告価格: ' + price + ' ' + currency + '\n\n' +
    '⚠️ 特に価格は出品価格と申告価格が異なる場合があります。\n' +
    '   正しい申告価格が入力されているか必ず確認してください。\n\n' +
    '問題なければ「OK」を押してください。'
  );
  if (!confirmed) return;

  chrome.storage.local.get(['companyName', 'nameAndTitle', 'email'], function (stored) {
    const config = {
      companyName:  stored.companyName  || '',
      nameAndTitle: stored.nameAndTitle || '',
      email:        stored.email        || ''
    };
    const data = buildDirectData(config);
    gData = data;
    gCells = {};
    gAllBlocksDone = true;
    buildPreviewAndShow();
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

/**
 * sectionInput 側の showInputMessage/showDirectMessage と同じ表示パターンを、
 * sectionPrint（リスト/印刷画面）向けに提供する。
 * 5本フルの状態で新規作成をブロックし、リスト画面へ強制的に呼び戻すケース
 * （sectionInput はもう表示されていないため、あちらのメッセージ欄は見えない）で使う。
 */
function showPrintMessage(text, type) {
  const el = document.getElementById('printMessage');
  if (!el) return;
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
  if (type === 'error' || type === 'warn') {
    setTimeout(function () {
      el.style.display = 'none';
    }, 10000);
  }
}

function hidePrintMessage() {
  const el = document.getElementById('printMessage');
  if (el) el.style.display = 'none';
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
  chrome.storage.local.get(['companyName', 'nameAndTitle', 'email', '_watchOpenAiKey'], function (stored) {
    if (stored.companyName) document.getElementById('companyName').value = stored.companyName;
    if (stored.nameAndTitle) document.getElementById('nameAndTitle').value = stored.nameAndTitle;
    if (stored.email) document.getElementById('email').value = stored.email;
    if (stored._watchOpenAiKey) {
      gOpenAiKey = stored._watchOpenAiKey;
      const keyEl = document.getElementById('openaiKey');
      if (keyEl) keyEl.value = gOpenAiKey;
    }
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

  const keyEl = document.getElementById('openaiKey');
  const openaiKey = keyEl ? keyEl.value.trim() : '';
  if (openaiKey) gOpenAiKey = openaiKey;

  const toSave = { companyName, nameAndTitle, email };
  if (openaiKey) toSave._watchOpenAiKey = openaiKey;

  chrome.storage.local.set(toSave, function () {
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
  { blockId: 7, fieldId: 'f_awb',            rowNum: 39, getInitial: function(d){ return d.awbNumber || ''; } },
  { blockId: 7, fieldId: 'f_wiz_companyName', rowNum: 36, getInitial: function(d){ return d.companyName || ''; } },
  { blockId: 7, fieldId: 'f_wiz_nameAndTitle', rowNum: 37, getInitial: function(d){ return d.nameAndTitle || ''; } },
  { blockId: 7, fieldId: 'f_wiz_email',      rowNum: 38, getInitial: function(d){ return d.email || ''; } }
];

const TOTAL_BLOCKS = 7;
/** 各ブロックが通過済みかどうかのフラグ */
const blockDone = {};

function initWizard(data) {
  initWizardWithCells(data, null);
}

/**
 * initWizard の拡張版。cells が渡された場合、各フィールドの初期値は
 * 「cells[rowNum] があればそれを優先、なければ f.getInitial(data)」で決める。
 * 複数時計の「編集」機能で、保存済みの gCells 上書き値を失わずに
 * ウィザードへ復元するために使う。cells が null/未指定なら従来の initWizard と完全に同じ挙動。
 */
function initWizardWithCells(data, cells) {
  const overrides = cells || {};

  // 全ブロックのフィールドに初期値を設定（cellsの上書きがあれば優先）
  WIZARD_FIELDS.forEach(function (f) {
    const el = document.getElementById(f.fieldId);
    if (!el) return;
    const override = overrides[f.rowNum];
    el.value = (override !== undefined) ? override : f.getInitial(data);
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
    // 中断＝今の current を捨てる操作。もしこれが「編集中」の1本なら、
    // 無言で消してしまわないよう編集前のオリジナルをリストへ戻す。
    restorePendingEditIfAny();
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
    // 編集を最後まで完了した＝この1本がそのまま current として確定する。
    // オリジナルへ戻す必要はなくなったので、保留中の編集マーカーだけクリアする
    // （新規作成の完了時もここを通るが、その場合はもともと未設定なので単なるno-op）。
    gEditingListIndex = null;
    gEditingBackup = null;
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
    // 「最初からやり直す」＝完全リセット。current だけでなく、
    // 積み上げた複数時計リスト（gWatchList）、保留中の編集状態も含めて全部破棄する。
    gData = null;
    gCells = {};
    gAllBlocksDone = false;
    gWatchList = [];
    gEditingListIndex = null;
    gEditingBackup = null;
    resetWatchInputForms();
    renderMultiWatchList();
    showSection('sectionInput');
  });

  document.getElementById('openPrintWindowBtn').addEventListener('click', function () {
    openPrintWindow();
  });

  const addWatchBtn = document.getElementById('addWatchBtn');
  if (addWatchBtn) {
    addWatchBtn.addEventListener('click', function () {
      addCurrentWatchAndContinue();
    });
  }
}

/**
 * ウィザードの gCells を反映した最終39行分のセル値マップを組み立てる（現在編集中の1本＝gData/gCells用）。
 * gData が null（＝現在編集中の1本がない状態。5本フルの状態でリストへ戻された直後など）の場合は
 * 空オブジェクトを返す。呼び出し側で data.xxx への直接アクセスが起きて落ちないようにするための安全弁。
 */
function buildFinalCells() {
  if (!gData) return {};
  return buildFinalCellsFor(gData, gCells);
}

/**
 * buildFinalCells の汎用版。任意の data/cells の組から39行分のセル値マップを組み立てる。
 * 複数時計リスト（gWatchList）内の各エントリーを印刷用に変換する際にも使う。
 */
function buildFinalCellsFor(data, cells) {
  const col = {};
  cells = cells || {};

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
  col[39] = data.awbNumber    || '';

  // cells の値で上書き（ウィザードで編集した値が最終出力に反映）
  Object.keys(cells).forEach(function (rowNum) {
    col[parseInt(rowNum, 10)] = cells[rowNum];
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

function renderTable(tableEl, col, watchLabel) {
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
  tdHValue.textContent = watchLabel || 'Watch 1';
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

/**
 * 画面上部の「現在編集中の1本」プレビュー表を描画する。
 * gData がある（＝通常どおり、確認ウィザードを完了した／プレビューへ直接進んだ）場合は
 * 従来どおりの39行テーブルを描画する。
 * gData が null（＝5本フルの状態で編集を中断し、current が無いままリスト画面へ戻された等）の
 * 場合は、直前の（すでに用済みの）内容を残さず、「現在編集中の時計はない」ことが分かる
 * プレースホルダーに差し替える。印刷対象はあくまで gWatchList のみになる。
 */
function renderCurrentWatchPreview() {
  const table = document.getElementById('previewTable');
  if (!table) return;

  if (gData) {
    const col        = buildFinalCells();
    // gWatchList に何本積まれているかで「現在編集中の1本」の通し番号が決まる
    // （リストが空＝1本目の場合は従来どおり常に "Watch 1"）。
    const watchLabel = 'Watch ' + (gWatchList.length + 1);
    renderTable(table, col, watchLabel);
    return;
  }

  table.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 2;
  td.className = 'ws-data';
  td.style.textAlign = 'left';
  td.textContent = '現在編集中の時計はありません。下のリストから印刷・編集・削除できます。';
  tr.appendChild(td);
  table.appendChild(tr);
}

function buildPreviewAndShow() {
  renderCurrentWatchPreview();
  renderMultiWatchList();
  hidePrintMessage(); // 前回の（もう関係ない）案内メッセージを残さない
  showSection('sectionPrint');
}

// ===========================================
// 複数時計（最大5本）リスト管理
// ===========================================
// 1本だけ作る通常フローの見た目・挙動は一切変えない。
// 「＋時計を追加」を押したときだけ gWatchList にスナップショットが積まれ、
// 印刷時に現在編集中の1本と合わせて出力される。

/** JSON経由の単純ディープコピー（gData/gCellsはプレーンなオブジェクトのみを持つ前提） */
function cloneWatchState(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

/** 現在「印刷対象」になる本数（保存済みリスト + 編集中の1本） */
function effectiveWatchCount() {
  return gWatchList.length + (gData ? 1 : 0);
}

function watchEntryTitle(data) {
  return (data && data.styleRef) ? data.styleRef : '(名称未設定)';
}

function watchEntryValueText(data) {
  if (!data || data.totalValue === undefined || data.totalValue === null || data.totalValue === '') return '';
  const cur = data.currency || 'USD';
  const num = Number(data.totalValue);
  return (isNaN(num) ? data.totalValue : num.toFixed(2)) + ' ' + cur;
}

/**
 * 保存済みリスト（gWatchList）＋現在編集中の1本の状況をプレビュー画面に描画する。
 * buildPreviewAndShow のたびと、追加/編集/削除のたびに呼び出す。
 */
function renderMultiWatchList() {
  const summaryEl = document.getElementById('multiSummary');
  const listEl    = document.getElementById('multiList');
  const noteEl    = document.getElementById('multiNote');
  const addBtn    = document.getElementById('addWatchBtn');
  if (!summaryEl || !listEl || !addBtn) return; // HTML未対応の環境向けガード

  const total = effectiveWatchCount();
  summaryEl.textContent = '登録済み: ' + total + ' / ' + MAX_WATCHES + ' 本';

  listEl.innerHTML = '';
  gWatchList.forEach(function (entry, idx) {
    const row = document.createElement('div');
    row.className = 'multi-row';

    const label = document.createElement('span');
    label.className = 'multi-row-label';
    label.textContent = 'No.' + (idx + 1) + '　' + watchEntryTitle(entry.data) + '　' + watchEntryValueText(entry.data);
    row.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-sm';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', function () { editWatchEntry(idx); });
    row.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-ghost btn-sm multi-delete';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', function () { deleteWatchEntry(idx); });
    row.appendChild(delBtn);

    listEl.appendChild(row);
  });

  if (noteEl) noteEl.style.display = (total >= 2) ? '' : 'none';

  const canAdd = total < MAX_WATCHES;
  addBtn.style.display = canAdd ? '' : 'none';
  addBtn.disabled = !canAdd;
}

/**
 * 「＋時計を追加（最大5本）」ボタン。
 * 通常は、現在編集中の1本（gData/gCells）をリストへスナップショットとして積んでから
 * 次の1本の入力画面へ戻る。
 * gData が null（＝current が無い「リストのみ」の状態。5本フルの状態で編集を中断し
 * ブロックされてこのリスト画面へ戻された直後など）の場合は、積む対象が無いので
 * その部分だけ飛ばし、入力画面へのナビゲーションだけ行う
 * （＝このボタンが唯一の「リストのみの状態から次の1本を作り始める」導線のため、
 *   ここで無言で何もしないと詰みになる）。
 */
function addCurrentWatchAndContinue() {
  if (effectiveWatchCount() >= MAX_WATCHES) return; // ボタンは非表示のはずだが二重ガード

  if (gData) {
    gWatchList.push({ data: cloneWatchState(gData), cells: cloneWatchState(gCells) });
    gData = null;
  }

  gCells = {};
  gAllBlocksDone = false;
  // この時点で current は必ずウィザードを完了済み（confirmDoneBtn or handleDirectToPreview経由）
  // なので、通常は既に null のはず。念のための二重クリア。
  gEditingListIndex = null;
  gEditingBackup = null;

  resetWatchInputForms();
  showSection('sectionInput');
}

/**
 * リスト内の1本を「編集」する。
 * 今 current になっている1本（あれば）はいったんリストへ退避してから、
 * 編集対象をリストから取り出して current にし、ウィザードをBlock1から開き直す。
 * 保存済みの gCells 上書き値は initWizardWithCells で復元し、失わない。
 * 編集し直した1本は、確認ウィザードを7ブロックすべて通過するまでリストへは戻らない
 * （再度「＋時計を追加」した時点、または印刷時に current として合流する）。
 *
 * 編集前のオリジナル（未編集）は gEditingBackup / gEditingListIndex として保持しておく。
 * ウィザードを完了せずに中断された場合、half-edited な状態ではなくこのオリジナルを
 * リストへ戻す（restorePendingEditIfAny 参照）。これをしないと「編集→中断」で
 * その1本が無言で消え、印刷対象から漏れてしまう（申告漏れリスク）。
 */
function editWatchEntry(index) {
  const entry = gWatchList[index];
  if (!entry) return;

  gEditingBackup     = cloneWatchState(entry);
  gEditingListIndex  = index;

  if (gData) {
    gWatchList.push({ data: cloneWatchState(gData), cells: cloneWatchState(gCells) });
  }
  gWatchList.splice(index, 1);

  gData = cloneWatchState(entry.data);
  gCells = {};
  gAllBlocksDone = false;

  initWizardWithCells(gData, entry.cells || {});
  showSection('sectionWizard');
}

/**
 * 「編集」を最後まで完了せずに中断した場合に呼ぶ安全弁。
 * gEditingListIndex が設定されている（＝編集中断が起きうる状態）なら、
 * 編集前のオリジナル（gEditingBackup）を元の位置へ差し戻してから、
 * 保留状態をクリアする。編集中でなければ何もしない（no-op、他のフローに影響なし）。
 *
 * 呼び出しポイント: 「← 最初から」（backToInputFromWizard）、および
 * handleCreate / handleDirectCreate / handleDirectToPreview の先頭
 * （＝いずれも「今の current を捨てて新しい1本を始める」操作のため、
 *   捨てられる current が実は編集中だった場合は必ずここを通る）。
 */
function restorePendingEditIfAny() {
  if (gEditingListIndex === null || gEditingListIndex === undefined) return;

  if (gEditingBackup) {
    gWatchList.splice(gEditingListIndex, 0, gEditingBackup);
  }
  gEditingListIndex = null;
  gEditingBackup = null;

  // プレビュー画面が表示中でなくても呼び出し自体は無害（DOM要素が無ければ内部で早期return）。
  renderMultiWatchList();
}

/** リスト内の1本を「削除」する（確認ダイアログあり。既存コードのwindow.confirmと同じ流儀）。 */
function deleteWatchEntry(index) {
  const entry = gWatchList[index];
  if (!entry) return;

  const label = watchEntryTitle(entry.data);
  const ok = window.confirm('「' + label + '」をリストから削除します。よろしいですか？\nこの操作は取り消せません。');
  if (!ok) return;

  gWatchList.splice(index, 1);
  renderMultiWatchList();
}

/**
 * 「＋時計を追加」で次の1本へ進む際、入力フォーム（貼り付け／直接入力）の内容を
 * 前の時計の値のまま残さないようにクリアする。gData/gCells/ウィザードのリセットとは別に必要。
 */
function resetWatchInputForms() {
  const pasteForm = document.getElementById('worksheetForm');
  if (pasteForm) pasteForm.reset();
  const directForm = document.getElementById('directForm');
  if (directForm) directForm.reset();

  hideInputMessage();
  const directMsg = document.getElementById('directInputMessage');
  if (directMsg) directMsg.style.display = 'none';

  const badge = document.getElementById('aiResultBadge');
  if (badge) badge.style.display = 'none';

  const titlePreview = document.getElementById('di_titlePreview');
  if (titlePreview) { titlePreview.style.display = 'none'; titlePreview.textContent = ''; }

  const printDirectBtn = document.getElementById('di_printDirectBtn');
  if (printDirectBtn) printDirectBtn.style.display = 'none';

  const htsError = document.getElementById('di_htsError');
  if (htsError) htsError.style.display = 'none';

  // ムーブメント種別・ケース素材に連動する副作用（Jewels表示/バッテリー国/HTSUS候補）を再適用
  onDirectMovementChange();
  updateHtsHint();
}

// ===========================================
// 印刷ウィンドウ（別ウィンドウ方式）
// ===========================================

/**
 * 印刷用ペイロードを組み立てる。
 * 1本のみ（gWatchList が空で current の1本だけ）の場合は、従来どおりフラットな
 * col オブジェクト（{3: ..., 4: ..., ...}）をそのまま返す＝挙動・データ形は完全に不変。
 * 2本以上の場合だけ { multi: true, watches: [col1, col2, ...] } 形式にする。
 */
function buildPrintPayloadObject() {
  const cols = gWatchList.map(function (entry) {
    return buildFinalCellsFor(entry.data, entry.cells);
  });
  if (gData) {
    cols.push(buildFinalCells());
  }

  if (cols.length <= 1) {
    return cols[0] || {};
  }
  return { multi: true, watches: cols };
}

function openPrintWindow() {
  if (effectiveWatchCount() === 0) {
    showPrintMessage('印刷する時計がありません。「＋ 時計を追加」から入力してください。', 'error');
    return;
  }

  const payloadObj = buildPrintPayloadObject();
  const payload    = JSON.stringify(payloadObj);

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

// ===========================================
// AI入力補助（商品ページ読み取り）
// ===========================================

function startAiFlow() {
  const msg = document.getElementById('aiAnalyzeMsg');
  const btn = document.getElementById('aiAnalyzeBtn');

  // 起動時にAPIキーを読み込む（設定保存後の最新値を使う）
  chrome.storage.local.get(['_watchOpenAiKey'], function (stored) {
    if (stored._watchOpenAiKey) gOpenAiKey = stored._watchOpenAiKey;

    if (!gOpenAiKey) {
      msg.className = 'message error';
      msg.textContent = 'APIキーが未設定です。右上の「会社情報設定」でOpenAI APIキーを入力してください。';
      msg.style.display = 'block';
      return;
    }

    btn.disabled = true;
    msg.className = 'message info';
    msg.textContent = '分析中…';
    msg.style.display = 'block';

    getWatchPageInfo(function (pageInfo, errReason) {
      if (!pageInfo) {
        msg.className = 'message error';
        msg.textContent = (errReason || 'ページ情報を取得できませんでした') + '。商品ページを開いてから試してください。';
        msg.style.display = 'block';
        btn.disabled = false;
        return;
      }
      callOpenAIWatch(pageInfo, function (err, aiData) {
        btn.disabled = false;
        if (err || !aiData) {
          msg.className = 'message error';
          msg.textContent = 'AI呼び出しに失敗しました: ' + (err ? err.message : '不明なエラー');
          msg.style.display = 'block';
          return;
        }
        msg.style.display = 'none';
        fillFromAi(aiData);
      });
    });
  });
}

function getWatchPageInfo(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs[0]) { cb(null, 'タブが見つかりません'); return; }
    const tab = tabs[0];
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      cb(null, '拡張機能や設定ページでは使えません。商品ページを開いてください'); return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        const url = location.href;
        const host = location.hostname;

        function getText(selectors) {
          for (let i = 0; i < selectors.length; i++) {
            const el = document.querySelector(selectors[i]);
            if (el && el.textContent.trim()) return el.textContent.trim().substring(0, 400);
          }
          return '';
        }
        function getMeta(names) {
          for (let i = 0; i < names.length; i++) {
            const el = document.querySelector('meta[property="' + names[i] + '"],meta[name="' + names[i] + '"]');
            if (el && el.getAttribute('content')) return el.getAttribute('content');
          }
          return '';
        }
        // 画像URL抽出（最大max件、httpsのみ）。サムネイルらしきURLは末尾に回して大きい画像を優先
        function getImages(selectors, max) {
          const found = [];
          function pushUrl(raw) {
            if (!raw) return;
            let u = raw.trim();
            if (u.indexOf(',') !== -1 || u.indexOf(' ') !== -1) {
              const candidates = u.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
              if (candidates.length) u = candidates[candidates.length - 1].split(' ')[0];
            }
            if (u.indexOf('//') === 0) u = 'https:' + u;
            if (u.indexOf('https://') !== 0) return;
            if (found.indexOf(u) === -1) found.push(u);
          }
          for (let i = 0; i < selectors.length; i++) {
            const els = document.querySelectorAll(selectors[i]);
            for (let j = 0; j < els.length; j++) {
              const el = els[j];
              pushUrl(el.getAttribute('src') || el.currentSrc || el.getAttribute('data-src') || el.getAttribute('srcset') || el.getAttribute('data-srcset'));
            }
          }
          const big = found.filter(function (u) { return !/thumb|_s\.|small/i.test(u); });
          const small = found.filter(function (u) { return /thumb|_s\.|small/i.test(u); });
          return big.concat(small).slice(0, max);
        }

        // JSON-LD Product schema
        let jsonldProduct = null;
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (let si = 0; si < scripts.length; si++) {
          try {
            const d = JSON.parse(scripts[si].textContent);
            const items = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
            for (let ii = 0; ii < items.length; ii++) {
              if (items[ii]['@type'] === 'Product') { jsonldProduct = items[ii]; break; }
            }
            if (jsonldProduct) break;
          } catch (e) {}
        }

        let productName = '', brand = '', condition = '', description = '', price = '', currency = '';
        let imageSelectors = [];

        if (host.includes('mercari.com')) {
          productName = getText(['h1[class*="name"]', 'h1[data-testid="name"]', 'p[data-testid="product-name"]', 'h1']);
          description = getText(['[data-testid="description"]', 'p[class*="description"]', '[class*="ItemDescription"]']).substring(0, 300);
          condition   = getText(['[data-testid="condition"]', '[class*="condition"]', 'span[class*="status"]']);
          brand       = getText(['[data-testid="brand"]', '[class*="brand"]']);
          price       = getText(['[data-testid="price"]', '[class*="price"] span', '[class*="ItemPrice"]']).replace(/[^0-9]/g, '');
          currency    = 'JPY';
          imageSelectors = ['[data-testid="image-0"] img', '[data-testid^="image-"] img', 'picture img', 'main img'];
        } else if (host.includes('auctions.yahoo.co.jp') || host.includes('buyee.jp')) {
          productName = getText(['h1[class*="Product__title"]', '.Product__title', 'h1']);
          description = getText(['.ProductExplanation__itemDescription', '.ProductDetail__description', '[class*="description"]']).substring(0, 300);
          condition   = getText(['.ProductDetail__condition', '[class*="condition"]']);
          price       = getText(['.Price__value', '.Auction__price', '.ProductDetail__price', '[class*="price"]']).replace(/[^0-9]/g, '');
          currency    = 'JPY';
          imageSelectors = ['.ProductImage__image img', '#photoImg img', '.itemPhoto img', '#Photos img', 'main img'];
        } else if (host.includes('hardoff.co.jp') || host.includes('bookoff.co.jp')) {
          productName = getText(['h1', '.item-name', '.product-name']);
          description = getText(['.item-detail', '.product-detail', '.description']).substring(0, 300);
          price       = getText(['.price', '.item-price', '[class*="price"]']).replace(/[^0-9]/g, '');
          currency    = 'JPY';
          imageSelectors = ['.item-photo img', '.photo-main img', '.product-image img', 'main img'];
        } else if (host.includes('ebay.com')) {
          productName = getText(['h1#itemTitle', 'h1[itemprop="name"]', 'h1']);
          description = getText(['#viTabs_0_is', '#itemDescriptionURL', '[itemprop="description"]']).substring(0, 300);
          brand       = getText(['[itemprop="brand"]', '[data-testid="x-item-specifics"] [class*="brand"]']);
          condition   = getText(['#condText', '[itemprop="itemCondition"]']);
          price       = getText(['.x-price-primary span', '[itemprop="price"]', '#prcIsum']).replace(/[^0-9.]/g, '');
          currency    = 'USD';
          imageSelectors = ['#icImg', '.ux-image-carousel-item img', '.ux-image-magnify__image img'];
        }

        if (jsonldProduct) {
          if (!productName) productName = jsonldProduct.name || '';
          if (!brand && jsonldProduct.brand) brand = typeof jsonldProduct.brand === 'string' ? jsonldProduct.brand : (jsonldProduct.brand.name || '');
          if (!description && jsonldProduct.description) description = String(jsonldProduct.description).substring(0, 300);
          if (!condition && jsonldProduct.itemCondition) condition = String(jsonldProduct.itemCondition).replace(/https?:\/\/schema\.org\//, '').replace('Condition', '');
        }

        if (!productName) productName = getText(['h1']) || getMeta(['og:title']) || document.title;
        if (!description) description = getMeta(['og:description', 'description']).substring(0, 300);

        // 商品メイン画像URL（最大3枚、https限定）。サイト別セレクタ→JSON-LD image→og:imageの順でフォールバック
        let imageUrls = getImages(imageSelectors, 3);
        if (imageUrls.length < 3 && jsonldProduct && jsonldProduct.image) {
          const jsonldImages = Array.isArray(jsonldProduct.image) ? jsonldProduct.image : [jsonldProduct.image];
          for (let ji = 0; ji < jsonldImages.length && imageUrls.length < 3; ji++) {
            const jUrl = typeof jsonldImages[ji] === 'string' ? jsonldImages[ji] : ((jsonldImages[ji] && jsonldImages[ji].url) || '');
            if (jUrl.indexOf('https://') === 0 && imageUrls.indexOf(jUrl) === -1) imageUrls.push(jUrl);
          }
        }
        if (imageUrls.length < 3) {
          const ogImage = getMeta(['og:image']);
          if (ogImage.indexOf('https://') === 0 && imageUrls.indexOf(ogImage) === -1) imageUrls.push(ogImage);
        }
        imageUrls = imageUrls.slice(0, 3);

        return { url, host, productName, brand, condition, description, price, currency, imageUrls };
      }
    }, function (results) {
      if (chrome.runtime.lastError) { cb(null, chrome.runtime.lastError.message); return; }
      if (results && results[0] && results[0].result) {
        cb(results[0].result, null);
      } else {
        cb(null, 'ページ情報を取得できませんでした');
      }
    });
  });
}

function callOpenAIWatch(pageInfo, cb) {
  const lines = ['Product URL: ' + pageInfo.url, 'Product name: ' + (pageInfo.productName || '')];
  if (pageInfo.brand)       lines.push('Brand: ' + pageInfo.brand);
  if (pageInfo.condition)   lines.push('Condition: ' + pageInfo.condition);
  if (pageInfo.description) lines.push('Description: ' + pageInfo.description);
  if (pageInfo.price)       lines.push('Price: ' + pageInfo.price + (pageInfo.currency ? ' ' + pageInfo.currency : ''));

  const userContent = lines.join('\n');

  const systemPrompt = [
    'You are a watch customs expert. Given product information from a Japanese secondhand watch listing, extract watch details.',
    'Return ONLY a JSON object with these exact fields:',
    '  "brand": watch brand name (e.g. "Citizen", "Seiko", "Casio")',
    '  "reference": model number or reference (e.g. "BM8180-03E")',
    '  "movementType": one of exactly: "Quartz", "Automatic", "Manual"',
    '  "jewelCount": positive integer number of jewels if explicitly stated in the text or images (e.g. "23 Jewels", "17石"), otherwise null. Never guess.',
    '  "displayType": one of exactly: "Analog", "Digital", "Analog-Digital"',
    '  "bandMaterial": one of exactly: "Textile", "Metal", "Leather", "No Band", "Unknown"',
    '  "bandDetail": specific band material (e.g. "Stainless Steel", "Leather (Cow)", "Rubber")',
    '  "caseMaterial": one of exactly: "NOT Gold/Silver Plated", "Gold/Silver Plated", "Metal Clad w/Precious Metal", "Wholly of Precious Metal", "Other"',
    '  "caseDetail": specific case base material (e.g. "Stainless Steel", "Titanium", "Brass")',
    '  "backplateMaterial": one of exactly: "Other", "Wholly of Precious Metal"',
    '  "backplateDetail": specific backplate material (e.g. "Stainless Steel", "Titanium")',
    '  "country": country of origin, default "Japan" for Japanese marketplace listings',
    '  "htsus": suggested HTSUS code, 10 digits no dots (e.g. "9102215040"). Use 9102215040 for quartz non-precious-case wristwatch, 9102217010 for mechanical non-precious-case.',
    '  "reason": one sentence in Japanese summarizing what was identified',
    'Set bandMaterial to "Unknown" only when neither the text nor the images make it clear; never guess.',
    'Return ONLY the JSON. No markdown, no explanation.'
  ].join('\n');

  const imageUrls = Array.isArray(pageInfo.imageUrls)
    ? pageInfo.imageUrls.filter(function (u) { return typeof u === 'string' && u.indexOf('https://') === 0; }).slice(0, 3)
    : [];
  let userMessageContent = userContent;
  if (imageUrls.length > 0) {
    userMessageContent = [{ type: 'text', text: userContent }];
    imageUrls.forEach(function (u) {
      userMessageContent.push({ type: 'image_url', image_url: { url: u, detail: 'low' } });
    });
  }

  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + gOpenAiKey },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessageContent }],
      max_completion_tokens: 400
    })
  })
  .then(function (r) {
    if (!r.ok) return r.json().then(function (errBody) { throw new Error((errBody.error && errBody.error.message) || ('HTTP ' + r.status)); });
    return r.json();
  })
  .then(function (data) {
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('AIからの応答が空でした');
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AIの応答にJSONが含まれていませんでした');
    try { cb(null, JSON.parse(match[0])); } catch (e) { throw new Error('JSONの解析に失敗しました: ' + e.message); }
  })
  .catch(function (e) { cb(e, null); });
}

/** AI読み取り結果が不確実なフィールド（バンド・石数）を強調表示する。
 *  2026-08-14対応: 画面上部のAIバッジ内の警告文だけでは気づかれにくいという実機フィードバック
 *  を受け、対象フィールド自体に赤枠＋ソフトな点滅（.ai-field-warn、panel.css）を付け、
 *  直下にインライン警告div（.ai-inline-warn）を挿入する。上部バッジのサマリ表示はこの
 *  関数とは別に従来どおり残す。同じフィールドに対して複数回呼ばれても、既存のインライン警告
 *  divを使い回すだけで二重に挿入はしない。 */
function setAiFieldWarning(fieldId, message) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.classList.add('ai-field-warn');
  let warnEl = document.getElementById(fieldId + '_aiWarn');
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.id = fieldId + '_aiWarn';
    warnEl.className = 'ai-inline-warn';
    field.insertAdjacentElement('afterend', warnEl);
  }
  warnEl.textContent = message;
}

/** setAiFieldWarningで付けた赤枠・点滅・インライン警告divを解除する。
 *  ユーザーがそのフィールドに入力・選択した時（setupDirectFormのinput/changeイベント）と、
 *  再度AI読み取りする直前（fillFromAiの先頭、前回状態のクリア）の両方から呼ばれる。 */
function clearAiFieldWarning(fieldId) {
  const field = document.getElementById(fieldId);
  if (field) field.classList.remove('ai-field-warn');
  const warnEl = document.getElementById(fieldId + '_aiWarn');
  if (warnEl && warnEl.parentNode) warnEl.parentNode.removeChild(warnEl);
}

function fillFromAi(aiData) {
  // 直接入力タブに切り替え
  switchInputMode('direct');

  // 前回のAI読み取りで付いたフィールド警告（赤枠・点滅・インライン警告文）をクリアしてから
  // 今回の判定結果で作り直す（前回の警告が残らないようにする。2026-08-14対応）
  clearAiFieldWarning('di_jewelCount');
  clearAiFieldWarning('di_bandMaterial');

  const bandWarningText  = 'バンドの有無・素材をページから判別できませんでした。商品画像を目で確認し、バンド欄を選択してください。';
  const jewelWarningText = '石数を読み取れませんでした。商品ページを確認して入力してください。';

  // 各フィールドに流し込む
  const set = function (id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  };

  set('di_brand', aiData.brand || '');
  set('di_reference', aiData.reference || '');

  // selectの値は選択肢に一致するものだけセット
  const validMovement = ['Quartz', 'Automatic', 'Manual'];
  if (aiData.movementType && validMovement.includes(aiData.movementType)) {
    set('di_movementType', aiData.movementType);
  }

  // 石数（Jewels）。正の整数(1〜99)のときのみセット。それ以外（null・0・文字列・範囲外）は未セット。
  // 機械式（Automatic/Manual）なのに取得できなかった場合のみ警告対象とする（Quartzは警告なし）。
  let jewelWarning = false;
  const jc = aiData.jewelCount;
  if (typeof jc === 'number' && Number.isInteger(jc) && jc >= 1 && jc <= 99) {
    set('di_jewelCount', jc);
  } else if (aiData.movementType === 'Automatic' || aiData.movementType === 'Manual') {
    jewelWarning = true;
    setAiFieldWarning('di_jewelCount', '⚠ ' + jewelWarningText);
  }

  const validDisplay = ['Analog', 'Digital', 'Analog-Digital'];
  if (aiData.displayType && validDisplay.includes(aiData.displayType)) {
    set('di_displayType', aiData.displayType);
  }
  const validBand = ['Textile', 'Metal', 'Leather', 'No Band'];
  let bandWarning = false;
  if (aiData.bandMaterial && validBand.includes(aiData.bandMaterial)) {
    set('di_bandMaterial', aiData.bandMaterial);
  } else if (aiData.bandMaterial) {
    // "Unknown" または既知4値以外 → 選択肢はセットせず警告のみ表示
    bandWarning = true;
    setAiFieldWarning('di_bandMaterial', '⚠ ' + bandWarningText);
  }
  set('di_bandDetail', aiData.bandDetail || '');

  const validCase = ['NOT Gold/Silver Plated', 'Gold/Silver Plated', 'Metal Clad w/Precious Metal', 'Wholly of Precious Metal', 'Other'];
  if (aiData.caseMaterial && validCase.includes(aiData.caseMaterial)) {
    set('di_caseMaterial', aiData.caseMaterial);
  }
  set('di_caseDetail', aiData.caseDetail || '');

  const validBack = ['Other', 'Wholly of Precious Metal'];
  if (aiData.backplateMaterial && validBack.includes(aiData.backplateMaterial)) {
    set('di_backplateMaterial', aiData.backplateMaterial);
  }
  set('di_backplateDetail', aiData.backplateDetail || '');

  // 製造国（一括セット → changeイベントで各パーツに反映）
  const countryEl = document.getElementById('di_countryMain');
  if (countryEl && aiData.country) {
    const countryOptions = Array.from(countryEl.options).map(function (o) { return o.value; });
    if (countryOptions.includes(aiData.country)) {
      countryEl.value = aiData.country;
    } else {
      countryEl.value = 'Other';
    }
    countryEl.dispatchEvent(new Event('change'));
  }

  // ムーブメント変更の副作用を反映
  document.getElementById('di_movementType').dispatchEvent(new Event('change'));

  // HTSUSコード（数字10桁のままセット。ドット付きへの変換はしない）
  if (aiData.htsus) {
    const digits = String(aiData.htsus).replace(/[^0-9]/g, '');
    if (digits.length === 10) {
      set('di_htsCode', digits);
      validateHtsFormat(digits);
    }
  }

  // HTSUS候補ヒントも更新
  updateHtsHint();

  // AIバッジ表示（上部のサマリ表示。フィールド直下のインライン警告とは別に従来どおり残す）
  const badge = document.getElementById('aiResultBadge');
  if (badge) {
    const reasonText = aiData.reason ? '💡 ' + aiData.reason : '';
    const escapeText = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    const bandWarningHtml = bandWarning
      ? '<div class="ai-reason" style="color:#b3261e;">⚠ ' + escapeText(bandWarningText) + '</div>'
      : '';
    const jewelWarningHtml = jewelWarning
      ? '<div class="ai-reason" style="color:#b3261e;">⚠ ' + escapeText(jewelWarningText) + '</div>'
      : '';
    badge.innerHTML = '✨ <strong>AI入力補助</strong> — 内容を確認・修正してください。<strong>価格は必ず手入力してください</strong>（申告価格と出品価格が異なる場合があります）。' +
      (reasonText ? '<div class="ai-reason">' + escapeText(reasonText) + '</div>' : '') +
      bandWarningHtml +
      jewelWarningHtml;
    badge.style.display = 'block';
  }

  // AI読み取り完了後は「印刷プレビューへ直接進む」ボタンを表示
  const printDirectBtn = document.getElementById('di_printDirectBtn');
  if (printDirectBtn) printDirectBtn.style.display = 'block';

  // 警告フィールドが画面外の場合もあるため、最初の警告フィールドへスクロールする
  // （フォーム内での上下順は石数欄の方がバンド欄より上のため、石数を優先する）
  const firstWarnFieldId = jewelWarning ? 'di_jewelCount' : (bandWarning ? 'di_bandMaterial' : null);
  if (firstWarnFieldId) {
    const firstWarnField = document.getElementById(firstWarnFieldId);
    if (firstWarnField && firstWarnField.scrollIntoView) {
      firstWarnField.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
