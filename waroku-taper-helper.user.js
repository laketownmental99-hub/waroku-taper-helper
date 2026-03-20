// ==UserScript==
// @name         Waroku 漸増漸減ヘルパー
// @namespace    http://tampermonkey.net/
// @version      0.6.4
// @description  waroku処方入力で薬剤の漸増・漸減スケジュールを一括入力するヘルパー（薬剤選択・複数規格対応）
// @match        https://*.waroku.net/patient/karte*
// @grant        none
// ==/UserScript==

(function () {
'use strict';

const STORAGE_KEY = 'waroku_taper_presets';

// ============================================================
// Angular ヘルパー
// ============================================================

function getCtrl() {
  const rpList = document.querySelector('.rp-list');
  if (!rpList) return null;
  let scope = angular.element(rpList).scope();
  while (scope && !scope.ctrl) scope = scope.$parent;
  return scope ? scope.ctrl : null;
}

function getScope(el) {
  if (!el) return null;
  let scope = angular.element(el).scope();
  while (scope && !scope.ctrl) scope = scope.$parent;
  return scope;
}

function getRootScope() {
  const rpList = document.querySelector('.rp-list');
  if (!rpList) return null;
  return angular.element(rpList).scope().$root;
}

function detectContext() {
  const doModal = document.querySelector('.modal.modal-fixed-footer.open');
  if (doModal) {
    const scope = getScope(doModal);
    if (scope?.ctrl?.orderInfo) {
      return { mode: 'do', orderRps: scope.ctrl.orderInfo.orderRps, ctrl: scope.ctrl, label: 'Doオーダーフォーム' };
    }
  }
  const ctrl = getCtrl();
  if (ctrl?.palettePrescribe?.orderRps) {
    return { mode: 'new', orderRps: ctrl.palettePrescribe.orderRps, ctrl, label: '新規処方' };
  }
  return null;
}

function generateUid() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < 10; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function deepClean(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => k === '$$hashKey' ? undefined : v));
}

// ============================================================
// 薬剤名から mg を抽出
// ============================================================

function extractMg(name) {
  const m = name.match(/([０-９\d]+(?:[.．][０-９\d]+)?)\s*[mｍ][gｇ]/i);
  if (!m) return null;
  const num = m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  return parseFloat(num);
}

// ============================================================
// 薬剤名から基本名を抽出（規格違いをグループ化するため）
// 例: "デュロキセチンカプセル20mg" → "デュロキセチン"
//     "セルトラリン錠25mg「トーワ」" → "セルトラリン"
// ============================================================

function extractBaseName(name) {
  const m = name.match(/^(.+?)\s*(錠|ＯＤ錠|OD錠|カプセル|細粒|散|顆粒|シロップ|液|ドライシロップ|テープ|パッチ|注射|坐剤|吸入)/);
  return m ? m[1] : name;
}

/**
 * mg情報がある variableMeds を基本名でグループ化する。
 * 返り値: [{ baseName, medIndices: [variableMeds内のindex, ...] }, ...]
 */
function groupMedsByBase(variableMeds) {
  const groups = [];
  const seen = {};
  variableMeds.forEach((m, mi) => {
    if (m.mg === null) return;
    const base = extractBaseName(m.medicineName);
    if (seen[base] !== undefined) {
      groups[seen[base]].medIndices.push(mi);
    } else {
      seen[base] = groups.length;
      groups.push({ baseName: base, medIndices: [mi] });
    }
  });
  return groups;
}

// ============================================================
// プリセット
// ============================================================

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}

function savePresets(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }

// ============================================================
// ボタン注入
// ============================================================

function injectButtons() {
  new MutationObserver(() => {
    // 新規処方エリア: rp-list の末尾に1つだけボタンを配置
    const rpList = document.querySelector('.rp-list');
    if (rpList && !rpList.closest('.modal') && !rpList.querySelector('.taper-helper-btn-wrap')) {
      const hasRp = rpList.querySelector('div[ng-click*="createNewRp"][ng-click*="PRESCRIBE"]');
      if (hasRp) {
        const wrap = document.createElement('div');
        wrap.className = 'taper-helper-btn-wrap';
        wrap.style.cssText = 'padding:8px 0 4px 8px;';
        wrap.appendChild(makeTaperBtn());
        rpList.appendChild(wrap);
      }
    }

    // Doオーダーフォーム: モーダル内に1つだけボタンを配置
    const doModal = document.querySelector('.modal.modal-fixed-footer.open');
    if (doModal && !doModal.querySelector('.taper-helper-btn-wrap')) {
      const hasRp = doModal.querySelector('div[ng-click*="createNewRp"]');
      if (hasRp) {
        const wrap = document.createElement('div');
        wrap.className = 'taper-helper-btn-wrap';
        wrap.style.cssText = 'padding:8px 0 4px 8px;display:flex;gap:8px;align-items:center;';
        wrap.appendChild(makeTaperBtn());
        // 前回のスケジュール状態があれば「スケジュール編集」ボタンも追加
        if (lastScheduleState) {
          wrap.appendChild(makeReopenBtn());
        }
        // モーダル内の処方リスト末尾に追加
        const rpArea = doModal.querySelector('.rp-list') || hasRp.closest('.rp-list') || doModal;
        rpArea.appendChild(wrap);
      }
    }
    // 既にボタンラップがあるが、スケジュール編集ボタンがない場合は追加
    if (doModal && lastScheduleState) {
      const wrap = doModal.querySelector('.taper-helper-btn-wrap');
      if (wrap && !wrap.querySelector('.taper-reopen-btn')) {
        wrap.appendChild(makeReopenBtn());
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function makeTaperBtn() {
  const b = document.createElement('button');
  b.className = 'taper-helper-btn';
  b.textContent = '漸増漸減';
  b.style.cssText = 'padding:4px 14px;background:#1976d2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
  b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openModal(); });
  return b;
}

function makeReopenBtn() {
  const b = document.createElement('button');
  b.className = 'taper-reopen-btn';
  b.textContent = '← スケジュール編集';
  b.style.cssText = 'padding:4px 14px;background:#ff9800;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;';
  b.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (lastScheduleState) {
      const { allMeds, variableMeds, orderRps, ctx } = lastScheduleState;
      showScheduleModal(allMeds, variableMeds, orderRps, ctx);
    } else {
      openModal();
    }
  });
  return b;
}

// ============================================================
// モーダル
// ============================================================

let modalEl = null;
let lastScheduleState = null; // 前回のスケジュール状態を記憶

function destroyModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function openModal() {
  destroyModal();
  const ctx = detectContext();
  if (!ctx) return alert('処方入力エリアが見つかりません。');

  const orderRps = ctx.orderRps;
  if (!orderRps?.length) return alert('先に処方欄に薬剤を入力してください。\n漸増漸減に使う全ての規格（例: 20mg と 30mg）を1つのRpに入れてから開いてください。');

  // 全薬剤を収集（重複排除、現在の用量も保持）
  const allMeds = [];
  orderRps.forEach(rp => rp.orderMedicines.forEach(m => {
    if (!allMeds.find(x => x.medicineName === m.medicineName))
      allMeds.push({
        medicineName: m.medicineName, unit: m.unit, medicine: m.medicine,
        dosageForm: m.dosageForm, mg: extractMg(m.medicineName),
        currentDose: parseFloat(m.dose) || 1,
      });
  }));

  // 薬剤が1つしかない場合はそのままスケジュール画面へ
  if (allMeds.length <= 1) {
    allMeds.forEach(m => { m._variable = true; });
    showScheduleModal(allMeds, allMeds, orderRps, ctx);
    return;
  }

  // --- 薬剤選択画面を表示 ---
  modalEl = document.createElement('div');
  modalEl.id = 'taper-modal-overlay';
  modalEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;justify-content:center;align-items:flex-start;padding-top:40px;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:8px;padding:24px;width:600px;max-height:85vh;overflow-y:auto;box-shadow:0 4px 24px rgba(0,0,0,0.3);font-family:sans-serif;font-size:13px;';

  const label = ctx.mode === 'do'
    ? '<span style="color:#e65100;font-weight:bold;">[Do]</span>'
    : '<span style="color:#1565c0;font-weight:bold;">[新規]</span>';

  box.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <h3 style="margin:0;font-size:15px;">漸増漸減する薬剤を選択 ${label}</h3>
    <button id="tp-sel-close" style="background:none;border:none;font-size:20px;cursor:pointer;">✕</button>
  </div>
  <p style="margin:0 0 12px;color:#555;">チェックした薬剤のみスケジュールテーブルで用量を編集できます。<br>チェックしない薬剤は元のRpとして別グループで保持されます。</p>
  <div id="tp-sel-list">
    ${allMeds.map((m, i) => `
    <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:4px;background:${i % 2 === 0 ? '#f8f8f8' : '#fff'};border-radius:4px;cursor:pointer;">
      <input type="checkbox" class="tp-sel-cb" data-idx="${i}" checked style="width:18px;height:18px;" />
      <span style="flex:1;font-size:12px;"><b>${esc(m.medicineName)}</b> (${esc(m.unit)})${m.mg ? ' — ' + m.mg + 'mg' : ''}</span>
      <span style="color:#888;font-size:11px;">現在: ${m.currentDose} ${esc(m.unit)}</span>
    </label>
    `).join('')}
  </div>
  <div style="margin-top:8px;padding:8px;background:#fff3e0;border-radius:4px;font-size:11px;color:#e65100;">
    <b>ヒント:</b> セルトラリン→デュロキセチンの切り替えなら、セルトラリン25mgとデュロキセチン20mg・30mgにチェックを入れてください。
  </div>
  <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;">
    <button class="tp-sm" id="tp-sel-all" style="background:#757575;">全選択</button>
    <button class="tp-sm" id="tp-sel-none" style="background:#757575;">全解除</button>
    <button class="tp-btn" id="tp-sel-next" style="background:#1976d2;">次へ →</button>
  </div>
  <style>
    .tp-btn{padding:7px 18px;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;}
    .tp-btn:hover{opacity:.85;}
    .tp-sm{padding:2px 8px;color:#fff;background:#1976d2;border:none;border-radius:3px;cursor:pointer;font-size:11px;}
    .tp-sm:hover{opacity:.85;}
  </style>
  `;

  modalEl.appendChild(box);
  document.body.appendChild(modalEl);

  // イベント
  document.getElementById('tp-sel-close').addEventListener('click', destroyModal);
  modalEl.addEventListener('click', e => { if (e.target === modalEl) destroyModal(); });

  document.getElementById('tp-sel-all').addEventListener('click', () => {
    document.querySelectorAll('.tp-sel-cb').forEach(cb => cb.checked = true);
  });

  document.getElementById('tp-sel-none').addEventListener('click', () => {
    document.querySelectorAll('.tp-sel-cb').forEach(cb => cb.checked = false);
  });

  document.getElementById('tp-sel-next').addEventListener('click', () => {
    const checkedIdxs = new Set();
    document.querySelectorAll('.tp-sel-cb:checked').forEach(cb => checkedIdxs.add(parseInt(cb.dataset.idx)));
    if (checkedIdxs.size === 0) return alert('少なくとも1つの薬剤を選択してください。');

    const variableMeds = allMeds.filter((_, i) => checkedIdxs.has(i));
    // allMedsは全薬剤（fixedMedsの情報も含む）を保持
    allMeds.forEach((m, i) => { m._variable = checkedIdxs.has(i); });
    destroyModal();
    showScheduleModal(allMeds, variableMeds, orderRps, ctx);
  });
}

// ============================================================
// 用法選択データ & モーダル
// ============================================================

const ADMIN_DATA = [
  { cat: '処方（内服）1回', items: [
    '1日1回 就寝前に', '1日1回 朝食後に', '1日1回 昼食後に', '1日1回 夕食後に',
    '1日1回 朝食前に', '1日1回 昼食前に', '1日1回 夕食前に',
    '1日1回 朝食間に', '1日1回 昼食間に', '1日1回 夕食間に',
    '1日1回 朝食直後に', '1日1回 昼食直後に', '1日1回 夕食直後に',
    '1日1回 起床時に',
  ]},
  { cat: '処方（内服）2回', items: [
    '1日2回 朝夕食後に', '1日2回 朝食後と就寝前に', '1日2回 朝昼食後に',
    '1日2回 昼夕食後に', '1日2回 朝夕食前に',
  ]},
  { cat: '処方（内服）3回', items: [
    '1日3回 毎食後に', '1日3回 毎食前に', '1日3回 毎食間に',
    '1日3回 毎食直後に', '1日3回 朝昼夕食後に',
  ]},
  { cat: '処方（内服）4回', items: [
    '1日4回 毎食後と就寝前に', '1日4回 毎食前と就寝前に',
  ]},
  { cat: '処方（内服）その他', items: [
    '1日1回', '2日に1回', '1週間に1回', '1週間に2回',
  ]},
  { cat: '処方（頓用）', items: [
    '疼痛時', '発熱時', '不眠時', '不安時', '嘔気時', '頭痛時',
    '便秘時', '咳嗽時',
  ]},
  { cat: '処方（外用）', items: [
    '1日1回 塗布', '1日2回 塗布', '1日3回 塗布',
    '1日1回 貼付', '1日1回 点眼',
    '1日2回 点眼', '1日3回 点眼', '1日4回 点眼',
  ]},
];

let adminModalEl = null;

function openAdminModal(callback) {
  if (adminModalEl) adminModalEl.remove();

  adminModalEl = document.createElement('div');
  adminModalEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:1999999;display:flex;justify-content:center;align-items:center;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:6px;width:560px;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,0.3);font-family:sans-serif;font-size:13px;';

  // ヘッダー
  const header = document.createElement('div');
  header.style.cssText = 'padding:10px 16px;border-bottom:1px solid #ccc;font-weight:bold;font-size:14px;background:#f0f0f0;border-radius:6px 6px 0 0;';
  header.textContent = '用法選択';
  box.appendChild(header);

  // 本体（左右分割）
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex:1;overflow:hidden;min-height:350px;';

  // 左パネル（カテゴリ）
  const leftPanel = document.createElement('div');
  leftPanel.style.cssText = 'width:160px;border-right:1px solid #ccc;overflow-y:auto;background:#f8f8f8;flex-shrink:0;';

  // 右パネル（用法リスト）
  const rightPanel = document.createElement('div');
  rightPanel.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0;';

  let selectedItem = null;

  function renderItems(catIdx) {
    rightPanel.innerHTML = '';
    const items = ADMIN_DATA[catIdx].items;
    items.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;';
      row.textContent = item;
      row.addEventListener('mouseenter', () => { row.style.background = '#e3f2fd'; });
      row.addEventListener('mouseleave', () => { row.style.background = selectedItem === item ? '#bbdefb' : ''; });
      row.addEventListener('click', () => {
        selectedItem = item;
        rightPanel.querySelectorAll('div').forEach(d => d.style.background = '');
        row.style.background = '#bbdefb';
      });
      row.addEventListener('dblclick', () => {
        selectedItem = item;
        doSelect();
      });
      rightPanel.appendChild(row);
    });
  }

  ADMIN_DATA.forEach((cat, idx) => {
    const catBtn = document.createElement('div');
    catBtn.style.cssText = 'padding:8px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid #e0e0e0;white-space:nowrap;';
    catBtn.textContent = cat.cat;
    catBtn.addEventListener('click', () => {
      leftPanel.querySelectorAll('div').forEach(d => { d.style.background = ''; d.style.fontWeight = ''; d.style.color = ''; });
      catBtn.style.background = '#1976d2';
      catBtn.style.fontWeight = 'bold';
      catBtn.style.color = '#fff';
      selectedItem = null;
      renderItems(idx);
    });
    catBtn.addEventListener('mouseenter', () => { if (catBtn.style.background !== 'rgb(25, 118, 210)') catBtn.style.background = '#e0e0e0'; });
    catBtn.addEventListener('mouseleave', () => { if (catBtn.style.background !== 'rgb(25, 118, 210)') catBtn.style.background = ''; });
    leftPanel.appendChild(catBtn);
  });

  body.appendChild(leftPanel);
  body.appendChild(rightPanel);
  box.appendChild(body);

  // フッター
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:10px 16px;border-top:1px solid #ccc;display:flex;justify-content:flex-end;gap:8px;background:#f8f8f8;border-radius:0 0 6px 6px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '閉じる';
  cancelBtn.style.cssText = 'padding:6px 20px;border:1px solid #999;background:#fff;border-radius:4px;cursor:pointer;font-size:13px;';
  cancelBtn.addEventListener('click', closeAdminModal);

  const okBtn = document.createElement('button');
  okBtn.textContent = '決定';
  okBtn.style.cssText = 'padding:6px 20px;border:none;background:#1976d2;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;';

  function doSelect() {
    if (selectedItem) {
      callback(selectedItem);
      closeAdminModal();
    } else {
      alert('用法を選択してください。');
    }
  }
  okBtn.addEventListener('click', doSelect);

  footer.appendChild(cancelBtn);
  footer.appendChild(okBtn);
  box.appendChild(footer);

  adminModalEl.appendChild(box);
  adminModalEl.addEventListener('click', e => { if (e.target === adminModalEl) closeAdminModal(); });
  document.body.appendChild(adminModalEl);

  // 最初のカテゴリを選択
  leftPanel.children[0]?.click();
}

function closeAdminModal() {
  if (adminModalEl) { adminModalEl.remove(); adminModalEl = null; }
}

/** スケジュール編集モーダル（薬剤選択後に表示） */
function showScheduleModal(allMeds, variableMeds, orderRps, ctx) {
  modalEl = document.createElement('div');
  modalEl.id = 'taper-modal-overlay';
  modalEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;justify-content:center;align-items:flex-start;padding-top:20px;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:8px;padding:20px;width:860px;max-height:90vh;overflow-y:auto;box-shadow:0 4px 24px rgba(0,0,0,0.3);font-family:sans-serif;font-size:13px;';
  box.innerHTML = buildHTML(allMeds, variableMeds, orderRps[0], ctx);
  modalEl.appendChild(box);
  document.body.appendChild(modalEl);
  wireEvents(allMeds, variableMeds, orderRps, ctx);
}

function buildHTML(allMeds, variableMeds, tplRp, ctx) {
  const presets = loadPresets();
  const pOpts = presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  const label = ctx.mode === 'do'
    ? '<span style="color:#e65100;font-weight:bold;">[Do]</span>'
    : '<span style="color:#1565c0;font-weight:bold;">[新規]</span>';

  const fixedMeds = allMeds.filter(m => !m._variable);

  return `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <div style="display:flex;align-items:center;gap:10px;">
      <button id="tp-back" class="tp-sm" style="background:#757575;padding:4px 10px;font-size:12px;">← 薬剤選択</button>
      <h3 style="margin:0;font-size:15px;">漸増漸減スケジュール ${label}</h3>
    </div>
    <button id="tp-close" style="background:none;border:none;font-size:20px;cursor:pointer;">✕</button>
  </div>
  <div style="margin-bottom:12px;padding:8px;background:#f5f5f5;border-radius:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
    <label><b>プリセット:</b></label>
    <select id="tp-preset-sel" style="padding:2px 4px;"><option value="">-- 選択 --</option>${pOpts}</select>
    <button class="tp-sm" id="tp-preset-load">読込</button>
    <button class="tp-sm" id="tp-preset-save">保存</button>
    <button class="tp-sm" id="tp-preset-del" style="background:#e53935;">削除</button>
    <input id="tp-preset-name" placeholder="プリセット名" style="padding:2px 4px;width:130px;" />
  </div>
  <div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
    <span style="display:flex;align-items:center;gap:6px;">
      <b>用法:</b>
      <span id="tp-admin-display" style="padding:4px 10px;border:1px solid #bbb;border-radius:4px;background:#fff;min-width:180px;font-size:13px;">${esc(tplRp.administrationString || '1日1回 就寝前に')}</span>
      <button class="tp-sm" id="tp-admin-btn" style="background:#1976d2;padding:4px 12px;">用法選択</button>
      <input type="hidden" id="tp-admin" value="${esc(tplRp.administrationString || '1日1回 就寝前に')}" />
    </span>
    <label><b>ステップ数:</b> <input id="tp-steps" type="number" value="4" min="1" max="20" style="width:55px;padding:2px 4px;" /></label>
    <label><b>デフォルト日数:</b> <input id="tp-defdays" type="number" value="7" min="1" max="365" style="width:55px;padding:2px 4px;" /></label>
    <button class="tp-sm" id="tp-refresh" style="background:#43a047;">テーブル更新</button>
  </div>
  ${fixedMeds.length > 0 ? `
  <div style="margin-bottom:8px;padding:8px;background:#e8f5e9;border-radius:4px;">
    <b style="font-size:12px;">非漸増漸減薬剤</b><span style="color:#666;font-size:11px;">（元のRpとして別グループで保持されます）</span><br/>
    ${fixedMeds.map(m => `<span style="display:inline-block;margin:2px 4px;padding:2px 6px;background:#c8e6c9;border-radius:3px;font-size:11px;">${esc(m.medicineName)} — ${m.currentDose} ${esc(m.unit)}</span>`).join('')}
  </div>` : ''}
  <div style="margin-bottom:6px;font-weight:bold;">スケジュール <span style="font-weight:normal;color:#666;">（漸増漸減する薬剤の数量を編集してください）</span></div>
  <div id="tp-table" style="overflow-x:auto;"></div>
  <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
    <button class="tp-btn" id="tp-preview" style="background:#ff9800;">プレビュー</button>
    <button class="tp-btn" id="tp-apply" style="background:#1976d2;">処方に反映</button>
  </div>
  <div id="tp-preview-area" style="margin-top:10px;display:none;"></div>
  <style>
    .tp-btn{padding:7px 18px;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;}
    .tp-btn:hover{opacity:.85;}
    .tp-sm{padding:2px 8px;color:#fff;background:#1976d2;border:none;border-radius:3px;cursor:pointer;font-size:11px;}
    .tp-sm:hover{opacity:.85;}
    #tp-table table{border-collapse:collapse;width:100%;}
    #tp-table th,#tp-table td{border:1px solid #ccc;padding:4px 6px;text-align:center;font-size:11px;}
    #tp-table th{background:#e0e0e0;font-weight:bold;}
    #tp-table input[type="number"]{width:60px;padding:1px 3px;text-align:center;border:1px solid #bbb;border-radius:3px;font-size:11px;}
    #tp-table .mg-sub{color:#888;font-size:10px;}
    #tp-table .drug-mg{font-size:10px;color:#1565c0;white-space:nowrap;}
    #tp-table .tp-period{min-width:80px;white-space:nowrap;}
    #tp-table tr:hover{background:#f5f5f5;}
  </style>`;
}

// ============================================================
// テーブル構築
// ============================================================

function getTableState() {
  const days = {}, doses = {};
  document.querySelectorAll('.tp-days').forEach(i => { days[i.dataset.step] = parseInt(i.value); });
  document.querySelectorAll('.tp-dose').forEach(i => { doses[i.dataset.step + '_' + i.dataset.med] = i.value; });
  return { days, doses };
}

/** 薬剤名を短縮する */
function shortName(name) {
  // 「錠」「カプセル」「OD錠」等の後ろの規格部分のみ残して短縮
  const m = name.match(/^(.+?[\u9320\u5264\u7c92\u5305])(.*)$/);
  if (m && m[1].length > 10) return m[1].substring(0, 10) + '…' + (m[2] || '');
  if (name.length > 15) return name.substring(0, 15) + '…';
  return name;
}

/** variableMedsのみ編集列、mg表示は同一薬剤グループごと */
function buildTable(allMeds, variableMeds, preserve) {
  const defDays = parseInt(document.getElementById('tp-defdays')?.value) || 7;
  const steps = parseInt(document.getElementById('tp-steps')?.value) || 4;
  const prev = preserve ? getTableState() : { days: {}, doses: {} };
  const mgGroups = groupMedsByBase(variableMeds);

  let h = '<table><thead><tr><th>Rp</th><th>日数</th>';
  variableMeds.forEach((m, i) => {
    const sn = shortName(m.medicineName);
    h += `<th>${esc(sn)}<br><small>(${esc(m.unit)})</small>${m.mg ? '<br><small>' + m.mg + 'mg/1' + esc(m.unit) + '</small>' : ''}</th>`;
  });
  // 同一薬剤グループごとの合計mg列
  if (mgGroups.length > 0) {
    mgGroups.forEach(g => {
      h += `<th class="drug-mg">${esc(g.baseName)}<br>合計mg</th>`;
    });
  }
  h += '<th>期間</th></tr></thead><tbody>';

  for (let s = 0; s < steps; s++) {
    const d = prev.days[s] !== undefined ? prev.days[s] : defDays;
    h += `<tr><td style="font-weight:bold;">${s + 1}</td>`;
    h += `<td><input type="number" class="tp-days" value="${d}" min="1" max="365" data-step="${s}"/></td>`;

    variableMeds.forEach((m, mi) => {
      const pk = s + '_' + mi;
      let dose = prev.doses[pk] !== undefined ? prev.doses[pk] : '';
      if (dose === '') dose = 0;
      h += `<td><input type="number" class="tp-dose" value="${dose}" data-step="${s}" data-med="${mi}" min="0" max="10" step="0.5"/></td>`;
    });

    // 同一薬剤グループごとの合計mgセル
    if (mgGroups.length > 0) {
      mgGroups.forEach((g, gIdx) => {
        let groupMg = 0;
        g.medIndices.forEach(mi => {
          const pk = s + '_' + mi;
          const dose = prev.doses[pk] !== undefined ? parseFloat(prev.doses[pk]) || 0 : 0;
          groupMg += dose * variableMeds[mi].mg;
        });
        h += `<td class="drug-mg-cell" data-step="${s}" data-group="${gIdx}" style="font-weight:bold;color:#1565c0;">${groupMg}mg</td>`;
      });
    }

    h += `<td class="tp-period" data-step="${s}">-</td></tr>`;
  }

  h += '</tbody></table>';
  return h;
}

function recalcAll(allMeds, variableMeds) {
  const mgGroups = groupMedsByBase(variableMeds);

  // 期間
  let cum = 1;
  document.querySelectorAll('.tp-days').forEach((inp, i) => {
    const d = parseInt(inp.value) || 7;
    const cell = document.querySelector(`.tp-period[data-step="${i}"]`);
    if (cell) cell.textContent = `${cum}\u301C${cum + d - 1}日目`;
    cum += d;
  });

  if (mgGroups.length === 0) return;

  const steps = parseInt(document.getElementById('tp-steps')?.value) || 4;
  for (let s = 0; s < steps; s++) {
    mgGroups.forEach((g, gIdx) => {
      let groupMg = 0;
      g.medIndices.forEach(mi => {
        const inp = document.querySelector(`.tp-dose[data-step="${s}"][data-med="${mi}"]`);
        if (!inp) return;
        const num = parseFloat(inp.value) || 0;
        groupMg += num * variableMeds[mi].mg;
      });

      const mgCell = document.querySelector(`.drug-mg-cell[data-step="${s}"][data-group="${gIdx}"]`);
      if (mgCell) mgCell.textContent = groupMg + 'mg';
    });
  }
}

// ============================================================
// イベント
// ============================================================

function wireEvents(allMeds, variableMeds, orderRps, ctx) {
  document.getElementById('tp-close').addEventListener('click', destroyModal);
  modalEl.addEventListener('click', e => { if (e.target === modalEl) destroyModal(); });

  // 薬剤選択に戻る
  document.getElementById('tp-back').addEventListener('click', () => {
    destroyModal();
    openModal();
  });

  const container = document.getElementById('tp-table');
  const render = (preserve) => {
    container.innerHTML = buildTable(allMeds, variableMeds, preserve);
    recalcAll(allMeds, variableMeds);
    container.querySelectorAll('.tp-days').forEach(i => i.addEventListener('input', () => recalcAll(allMeds, variableMeds)));
    container.querySelectorAll('.tp-dose').forEach(i => i.addEventListener('input', () => recalcAll(allMeds, variableMeds)));
  };

  render(false);

  // 用法選択ボタン
  document.getElementById('tp-admin-btn').addEventListener('click', () => {
    openAdminModal(selected => {
      document.getElementById('tp-admin').value = selected;
      document.getElementById('tp-admin-display').textContent = selected;
    });
  });

  document.getElementById('tp-refresh').addEventListener('click', () => render(false));

  document.getElementById('tp-preview').addEventListener('click', () => {
    showPreview(collectSchedule(allMeds, variableMeds), allMeds, variableMeds);
  });

  document.getElementById('tp-apply').addEventListener('click', () => {
    applySchedule(collectSchedule(allMeds, variableMeds), allMeds, variableMeds, orderRps, ctx);
  });

  // プリセット
  document.getElementById('tp-preset-save').addEventListener('click', () => {
    const name = document.getElementById('tp-preset-name').value.trim();
    if (!name) return alert('プリセット名を入力してください');
    const presets = loadPresets();
    presets.push({
      name,
      administration: document.getElementById('tp-admin').value,
      medicineNames: allMeds.map(m => m.medicineName),
      variableNames: variableMeds.map(m => m.medicineName),
      steps: collectSchedule(allMeds, variableMeds),
    });
    savePresets(presets);
    alert(`「${name}」を保存しました`);
    refreshPresetSel();
  });

  document.getElementById('tp-preset-load').addEventListener('click', () => {
    const idx = parseInt(document.getElementById('tp-preset-sel').value);
    if (isNaN(idx)) return;
    const preset = loadPresets()[idx];
    if (!preset) return;
    document.getElementById('tp-admin').value = preset.administration || '';
    document.getElementById('tp-steps').value = preset.steps.length;
    render(false);
    setTimeout(() => {
      preset.steps.forEach((step, si) => {
        const di = document.querySelector(`.tp-days[data-step="${si}"]`);
        if (di) di.value = step.days;
        // variableMedsの用量を復元
        if (step.varDoses) {
          step.varDoses.forEach((dose, mi) => {
            const inp = document.querySelector(`.tp-dose[data-step="${si}"][data-med="${mi}"]`);
            if (inp) inp.value = dose;
          });
        } else if (step.doses) {
          // 旧形式互換
          step.doses.forEach((dose, mi) => {
            const inp = document.querySelector(`.tp-dose[data-step="${si}"][data-med="${mi}"]`);
            if (inp) inp.value = dose;
          });
        }
      });
      recalcAll(allMeds, variableMeds);
    }, 50);
  });

  document.getElementById('tp-preset-del').addEventListener('click', () => {
    const idx = parseInt(document.getElementById('tp-preset-sel').value);
    if (isNaN(idx)) return;
    const presets = loadPresets();
    if (confirm(`「${presets[idx].name}」を削除しますか？`)) {
      presets.splice(idx, 1);
      savePresets(presets);
      refreshPresetSel();
    }
  });
}

function refreshPresetSel() {
  const sel = document.getElementById('tp-preset-sel');
  if (!sel) return;
  const presets = loadPresets();
  sel.innerHTML = '<option value="">-- 選択 --</option>' + presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
}

// ============================================================
// データ収集
// ============================================================

/**
 * スケジュール収集: allMedsの全薬剤分の doses 配列を返す。
 * variableMedsはテーブルから、fixedMedsはcurrentDoseから取得。
 */
function collectSchedule(allMeds, variableMeds) {
  const steps = parseInt(document.getElementById('tp-steps')?.value) || 4;
  const result = [];
  let cum = 1;

  // variableMedsの名前→テーブル列インデックスのマップ
  const varMap = {};
  variableMeds.forEach((m, mi) => { varMap[m.medicineName] = mi; });

  for (let s = 0; s < steps; s++) {
    const days = parseInt(document.querySelector(`.tp-days[data-step="${s}"]`)?.value) || 7;

    // allMeds順に全薬剤の用量を構築
    const doses = allMeds.map(m => {
      if (m._variable) {
        const mi = varMap[m.medicineName];
        return parseFloat(document.querySelector(`.tp-dose[data-step="${s}"][data-med="${mi}"]`)?.value) || 0;
      } else {
        return m.currentDose || 0; // 固定
      }
    });

    // variableMedsだけの用量も保存（プリセット用）
    const varDoses = variableMeds.map((m, mi) =>
      parseFloat(document.querySelector(`.tp-dose[data-step="${s}"][data-med="${mi}"]`)?.value) || 0
    );

    result.push({ stepNum: s + 1, days, doses, varDoses, startDay: cum, endDay: cum + days - 1 });
    cum += days;
  }
  return result;
}

// ============================================================
// プレビュー
// ============================================================

function showPreview(schedule, meds, variableMeds) {
  const area = document.getElementById('tp-preview-area');
  area.style.display = 'block';

  // 非漸増漸減Rpの情報を収集
  const fixedMeds = meds.filter(m => !m._variable);
  const varMedsWithMg = variableMeds.filter(m => m.mg !== null);

  let h = '<div style="font-weight:bold;margin-bottom:4px;">プレビュー:</div>';

  // 非漸増漸減薬剤の表示
  if (fixedMeds.length > 0) {
    h += '<div style="margin-bottom:8px;padding:6px 8px;background:#e8f5e9;border-radius:4px;font-size:11px;">';
    h += '<b>非漸増漸減Rp（別グループで保持）:</b><br/>';
    fixedMeds.forEach(m => {
      h += `<span style="display:inline-block;margin:2px 4px;padding:2px 6px;background:#c8e6c9;border-radius:3px;">${esc(m.medicineName)} — ${m.currentDose} ${esc(m.unit)}</span>`;
    });
    h += '</div>';
  }

  // 同一薬剤グループ（プレビュー用）
  const previewGroups = groupMedsByBase(variableMeds);
  const thStyle = 'border:1px solid #ccc;padding:3px;';

  h += '<table style="border-collapse:collapse;width:100%;font-size:11px;">';
  h += `<tr style="background:#e0e0e0;"><th style="${thStyle}">Rp</th><th style="${thStyle}">薬剤</th><th style="${thStyle}">数量</th>`;
  // グループごとの合計mg列ヘッダー
  previewGroups.forEach(g => {
    h += `<th style="${thStyle}font-weight:bold;color:#1565c0;">${esc(g.baseName)}<br>mg</th>`;
  });
  h += `<th style="${thStyle}">日数</th><th style="${thStyle}min-width:70px;">期間</th></tr>`;

  schedule.forEach(step => {
    // 漸増漸減薬剤のみ表示（variableのみ）
    const active = [];
    step.doses.forEach((d, i) => {
      if (d > 0 && meds[i]._variable) {
        active.push({ name: meds[i].medicineName, unit: meds[i].unit, mg: meds[i].mg, dose: d });
      }
    });
    if (!active.length) return;

    // グループごとのmg合計を事前計算
    const groupMgTotals = previewGroups.map(g => {
      let total = 0;
      g.medIndices.forEach(mi => {
        const medName = variableMeds[mi].medicineName;
        const allMedIdx = meds.findIndex(m => m.medicineName === medName);
        if (allMedIdx >= 0 && step.doses[allMedIdx] > 0) {
          total += step.doses[allMedIdx] * (variableMeds[mi].mg || 0);
        }
      });
      return total;
    });

    active.forEach((m, j) => {
      h += '<tr>';
      if (j === 0) h += `<td rowspan="${active.length}" style="${thStyle}font-weight:bold;">${step.stepNum}</td>`;
      h += `<td style="${thStyle}">${esc(m.name)}</td>`;
      h += `<td style="${thStyle}">${m.dose} ${esc(m.unit)}</td>`;
      if (j === 0) {
        previewGroups.forEach((g, gi) => {
          h += `<td rowspan="${active.length}" style="${thStyle}font-weight:bold;color:#1565c0;">${groupMgTotals[gi]}mg</td>`;
        });
        h += `<td rowspan="${active.length}" style="${thStyle}">${step.days}日</td>`;
        h += `<td rowspan="${active.length}" style="${thStyle}min-width:70px;">${step.startDay}\u301C${step.endDay}日目</td>`;
      }
      h += '</tr>';
    });
  });

  h += '</table>';
  area.innerHTML = h;
}

// ============================================================
// 処方反映
// ============================================================

function applySchedule(schedule, meds, variableMeds, orderRps, ctx) {
  const adminStr = document.getElementById('tp-admin')?.value || orderRps[0]?.administrationString || '1日1回 就寝前に';

  // 漸増漸減薬剤の名前セット
  const variableNames = new Set(variableMeds.map(m => m.medicineName));

  // 非漸増漸減Rpを特定して保持（漸増漸減薬剤を含まないRpをそのまま保持）
  const nonTaperRps = [];
  const taperRelatedRps = [];
  orderRps.forEach(rp => {
    const hasVariable = rp.orderMedicines.some(m => variableNames.has(m.medicineName));
    if (hasVariable) {
      taperRelatedRps.push(rp);
    } else {
      nonTaperRps.push(deepClean(rp));
    }
  });

  // 漸増漸減薬剤のみを含む有効ステップ
  const validSteps = schedule.filter(s =>
    s.doses.some((d, i) => d > 0 && meds[i]._variable)
  );

  const totalRps = nonTaperRps.length + validSteps.length;
  const msg = nonTaperRps.length > 0
    ? `【${ctx.label}】\n非漸増漸減Rp: ${nonTaperRps.length}個（保持）\n漸増漸減Rp: ${validSteps.length}個（新規作成）\n合計: ${totalRps}個のRpになります。\nよろしいですか？`
    : `【${ctx.label}】\n現在のRp (${orderRps.length}個) → ${validSteps.length}個に置き換えます。\nよろしいですか？`;

  if (!confirm(msg)) return;

  // テンプレート: 漸増漸減関連のRpから取得
  const tplRp = deepClean(taperRelatedRps[0] || orderRps[0]);

  // 薬剤テンプレートを全Rpから収集
  const medTpls = {};
  orderRps.forEach(rp => rp.orderMedicines.forEach(m => {
    if (!medTpls[m.medicineName]) medTpls[m.medicineName] = deepClean(m);
  }));

  // orderRpsをクリアして再構築
  orderRps.length = 0;

  // 1. 非漸増漸減Rpを先頭に追加
  nonTaperRps.forEach((rp, idx) => {
    rp.rpNumber = idx + 1;
    rp.uid = rp.uid || generateUid();
    orderRps.push(rp);
  });

  // 2. 漸増漸減Rpを追加（variableの薬剤のみ含む）
  const startIdx = nonTaperRps.length;
  validSteps.forEach((step, idx) => {
    const rp = JSON.parse(JSON.stringify(tplRp));
    rp.uid = generateUid();
    rp.rpNumber = startIdx + idx + 1;
    rp.administrationString = adminStr;
    rp.numOfDays = step.days;
    rp.comment = `${step.startDay}\u301C${step.endDay}日目`;
    rp.selected = true;
    rp.orderMedicines = [];

    step.doses.forEach((dose, mi) => {
      if (dose <= 0) return;
      if (!meds[mi]._variable) return; // 固定薬剤はスキップ
      const tpl = medTpls[meds[mi].medicineName];
      if (!tpl) return;
      const med = JSON.parse(JSON.stringify(tpl));
      med.uid = generateUid();
      med.dose = String(dose);
      med.rpNumber = 0;
      rp.orderMedicines.push(med);
    });

    if (rp.orderMedicines.length > 0) orderRps.push(rp);
  });

  try {
    const rs = getRootScope();
    if (rs) { rs.$$phase ? rs.$evalAsync() : rs.$apply(); }
  } catch (e) { console.warn('[漸増漸減] $apply error:', e); }

  const taperCount = orderRps.length - nonTaperRps.length;
  const resultMsg = nonTaperRps.length > 0
    ? `${orderRps.length} 個のRpを作成しました。\n（非漸増漸減: ${nonTaperRps.length}個 + 漸増漸減: ${taperCount}個）\n内容を確認の上「指示」を押してください。`
    : `${orderRps.length} 個のRpを作成しました。\n内容を確認の上「指示」を押してください。`;
  // スケジュール状態を記憶（Doフォームから再編集できるように）
  lastScheduleState = { allMeds, variableMeds, orderRps, ctx };
  // 既存のスケジュール編集ボタンを削除（MutationObserverが再注入する）
  document.querySelectorAll('.taper-reopen-btn').forEach(b => b.remove());

  alert(resultMsg);
  destroyModal();
}

// ============================================================
// 初期化
// ============================================================

function init() {
  setTimeout(injectButtons, 1500);
  console.log('[漸増漸減ヘルパー] v0.6.4 初期化完了');
}

if (document.readyState === 'complete') init();
else window.addEventListener('load', init);

})();
