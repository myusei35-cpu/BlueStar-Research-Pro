// ============================================================
// ===== PATCH: メルカリサーチ Quetta統合ブロック v3 =====
//   独立IIFE・msq_接頭辞で完全分離。既存list_extractorに一切干渉しない。
//   セカスト商品ページ: 青ボタン注入 → Lens遷移
//   Lens(www.google.com/search?vsrid= 等): storage.msq_payloadがある時だけ起動
//   メルカリ検索(__msq=1&__t=): オーバーレイで相場表示
// ============================================================
// ============================================================
// メルカリサーチ Quetta版 (mersearch_quetta.js)
// 設計: background / chrome.tabs / DPoP を一切使わない。
//   セカスト(content) → Lens(content) → メルカリ検索(content)
//   の「画面遷移チェーン」で完結。状態は chrome.storage.local の
//   ワンショット受け渡し(使用後即削除)。
//   メルカリ価格は同一オリジン GET fetch(og meta読み) で取得。
//   これは fetchSingleItem(credentials:'omit') と同じで DPoP 不要。
//
// オリジナル「メルカリサーチ」の動き・手順・ロジックを完全再現:
//   ①ボタン押下→商品情報抽出(extractProductInfo そのまま)
//   ②画像1枚目で Lens 画像検索(lens-scraper のID抽出ロジックそのまま)
//   ③Lensヒットのメルカリ商品IDを、個別ページfetchで価格/画像/状態取得
//     + 検索DOMでSOLD確定(二重確定) → 削除商品はnull除外
//   ④独自オーバーレイ一覧(サマリー/フィルタ/ソート/カード)表示
// ============================================================
(function () {
  'use strict';

  // ---- 二重注入防止 ----
  if (window.__msQuettaRan__) return;
  window.__msQuettaRan__ = true;

  // ---- 状態受け渡しキー ----

  // ---- ページ判定 ----
  const HOST = location.hostname;
  const PATH = location.pathname;
  const IS_SECA   = /(^|\.)2ndstreet\.jp$/.test(HOST);
  const IS_SHOPS  = /(^|\.)mercari-shops\.com$/.test(HOST) && /\/products\/(create|[^/]+\/edit)/.test(PATH);
  const IS_BRANDEAR = /(^|\.)brandear\.jp$/.test(HOST) && /\/search\/detail\/AuctionID\//.test(PATH);
  const IS_KIND   = /(^|\.)kind\.co\.jp$/.test(HOST) && /\/products\//.test(PATH);
  const IS_YAHOO  = /(^|\.)auctions\.yahoo\.co\.jp$/.test(HOST) && /\/jp\/auction\//.test(PATH);
  const IS_HOST   = IS_SECA || IS_SHOPS || IS_BRANDEAR || IS_KIND || IS_YAHOO;  // ボタンを出す側(セカスト/ショップス/ブランディア/カインドオル/ヤフオク)
  const MSQ_IS_MOBILE = /Mobile/.test(navigator.userAgent);  // true=Quetta等(URL遷移), false=PC Chrome(新タブ)
  const IS_MOBILE = /Mobile/.test(navigator.userAgent);  // true=Quetta等モバイル(URL遷移), false=PC Chrome(新タブ)
  const IS_LENS   = /(^|\.)lens\.google\.com$/.test(HOST) ||
                    (/(^|\.)google\.com$/.test(HOST) && /[?&](vsrid=|udm=44|tbs=sbi)/.test(location.search));
  const IS_MERSEARCH = /(^|\.)jp\.mercari\.com$/.test(HOST) &&
                       /^\/search/.test(PATH) &&
                       /[?&]__msq=1/.test(location.search);

  // ============================================================
  // 共通ユーティリティ
  // ============================================================
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function isNewish(c) { if (!c) return false; return /新品[、,・\s]?\s*未使用|未使用に近い/.test(c); }
  // 商品状態を6分類に正規化
  function condClass(c) {
    if (!c) return 'unknown';
    if (/新品[、,・\s]?\s*未使用/.test(c)) return 'new';        // 新品、未使用
    if (/未使用に近い/.test(c)) return 'likenew';               // 未使用に近い
    if (/目立った傷や汚れなし/.test(c)) return 'good';           // 目立った傷や汚れなし
    if (/やや傷や汚れあり/.test(c)) return 'fair';               // やや傷や汚れあり
    if (/傷や汚れあり/.test(c)) return 'poor';                   // 傷や汚れあり
    if (/全体的に状態が悪い/.test(c)) return 'bad';              // 全体的に状態が悪い
    return 'unknown';
  }
  const COND_LABEL = { new:'新品', likenew:'未使用に近い', good:'目立った傷なし', fair:'やや傷あり', poor:'傷あり', bad:'状態悪い', unknown:'不明' };


  // ============================================================
  // ルーティング
  // ============================================================
  if (IS_HOST)          initSeca();
  else if (IS_MERSEARCH) initMercari();
  else if (IS_LENS)      initLens();

  // ============================================================
  // ① セカスト側
  // ============================================================
  function initSeca() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(setupSeca, 800));
    } else {
      setTimeout(setupSeca, 800);
    }
  }

  function setupSeca() {
    if (isProductPage()) injectSecaButton();
    // メルカリから全結果を持ち帰った場合(#__msqresult=)、ツールに表示
    tryShowResultFromHash();
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => { if (isProductPage() && !document.getElementById('msq-fab')) injectSecaButton(); }, 1000);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // セカストに戻った時、URL fragmentの__msqresultを読んでツールに全件表示
  function tryShowResultFromHash() {
    try {
      const h = location.hash || '';
      const m = h.match(/__msqresult=([^&]+)/);
      if (!m) return;
      const packed = JSON.parse(decodeURIComponent(m[1]));
      if (!Array.isArray(packed) || !packed.length) return;
      // packed → items形式に復元
      const items = packed.map(o => ({
        id: o.i, price: o.p || 0,
        isSold: o.s === 1 ? true : (o.s === 0 ? false : null),
        condition: revCond(o.c), name: o.t || '', thumbnail: o.h || '',
        url: 'https://jp.mercari.com/item/' + o.i, likes: 0
      }));
      const summary = calculateSummary(items);
      const info = msqExtractInfo();
      info.brand = '';
      info.keyword = buildKeyword(info);
      injectStyle();
      showOverlay(info, { items, summary, error: null });
      // fragmentを消す(再表示ループ防止・URLきれいに)
      try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
    } catch(e){}
  }
  // condClassコード → 表示テキスト(逆変換)
  function revCond(c) {
    const M = { new:'新品、未使用', likenew:'未使用に近い', good:'目立った傷や汚れなし',
                fair:'やや傷や汚れあり', poor:'傷や汚れあり', bad:'全体的に状態が悪い', unknown:'' };
    return M[c] || '';
  }

  function isProductPage() {
    const p = location.pathname, h = location.href;
    if (IS_SHOPS && /\/products\/(create|[^/]+\/edit)/.test(p)) return true;
    if (IS_BRANDEAR) return true;
    if (IS_KIND) return true;
    if (IS_YAHOO) return true;
    if (p.includes('/goods/detail') || /\/goods\/\d+/.test(p) || /goodsId=/.test(h)) return true;
    if (document.querySelector('.goodsDetail, .itemDetail, #goodsDetail')) return true;
    if (document.querySelector('[class*="addToCart"], [class*="cart-btn"]')) return true;
    return false;
  }

  function injectSecaButton() {
    if (document.getElementById('msq-fab')) return;
    injectStyle();
    const btn = document.createElement('button');
    btn.id = 'msq-fab';
    btn.textContent = '🛍 メルカリ相場';
    btn.addEventListener('click', onSecaButtonClick);
    document.body.appendChild(btn);
  }

  async function onSecaButtonClick() {
    let info;
    if (IS_SHOPS) {
      info = extractShopsInfo();
    } else if (IS_BRANDEAR) {
      info = extractBrandearInfo();
    } else if (IS_KIND) {
      info = extractKindInfo();
    } else if (IS_YAHOO) {
      info = extractYahooInfo();
    } else {
      info = msqExtractInfo();
    }
    if (!info.images.length) { alert('商品画像が取得できませんでした'); return; }
    let q = ((info.brand || '') + ' メルカリ').trim();
    // Quetta+ショップス: referrerがトップになり戻り先が取れないため、
    //   下書きURLを q の末尾に区切り記号で載せて運ぶ(qはLens結果まで生き残る)。
    if (MSQ_IS_MOBILE && (IS_SHOPS || IS_BRANDEAR || IS_KIND || IS_YAHOO)) {
      q = q + ' ##BACK##' + location.href;
    }
    const lensUrl = 'https://lens.google.com/uploadbyurl?url=' +
      encodeURIComponent(info.images[0]) + '&hl=ja&q=' + encodeURIComponent(q);

    if (MSQ_IS_MOBILE) {
      // Quetta等: 新タブ/storage/opener が全て不可。同タブ遷移でLensへ。
      //   結果はメルカリ→URL fragmentで元ページ(referrer)へ運ぶ従来方式。
      location.assign(lensUrl);
    } else {
      // PC Chrome: 元タブを残して新タブでリサーチ。結果はstorage経由で戻す。
      injectStyle();
      showOverlay(info, null);
      msqOpenResearchTab(lensUrl);
    }
  }

  // 新タブでリサーチを開始し、chrome.storageで結果を受け取る
  let msqResearchWin = null;
  function msqOpenResearchTab(lensUrl) {
    // 古い結果を消してから開始
    try { chrome.storage.local.remove('msq_result'); } catch(e){}
    // storageをポーリングで読む(QuettaはonChangedがcontentに届かないため自分で取りに行く)
    const applyResult = (data) => {
      const items = (data.items || []).map(o => ({
        id: o.i, price: o.p || 0, isSold: null,
        condition: revCond(o.c), name: o.t || '', thumbnail: o.h || '',
        url: 'https://jp.mercari.com/item/' + o.i, likes: 0
      }));
      const info = (IS_SHOPS ? extractShopsInfo() : IS_BRANDEAR ? extractBrandearInfo() : IS_KIND ? extractKindInfo() : IS_YAHOO ? extractYahooInfo() : msqExtractInfo());
      info.brand = '';
      const summary = calculateSummary(items);
      showOverlay(info, { items, summary, error: items.length ? null : 'メルカリ該当なし' });
    };
    let msqPollGot = false;
    const pollTimer = setInterval(() => {
      if (msqPollGot) { clearInterval(pollTimer); return; }
      try {
        chrome.storage.local.get('msq_result', (v) => {
          if (v && v.msq_result && v.msq_result.items) {
            msqPollGot = true;
            clearInterval(pollTimer);
            try { chrome.storage.local.remove('msq_result'); } catch(e){}
            try { if (msqResearchWin && !msqResearchWin.closed) msqResearchWin.close(); } catch(e){}
            applyResult(v.msq_result);
          }
        });
      } catch(e){}
    }, 1500);
    setTimeout(() => clearInterval(pollTimer), 120000);
    msqResearchWin = window.open(lensUrl, '_blank');
    if (!msqResearchWin) { alert('新タブを開けませんでした。ポップアップを許可してください'); }
  }

  // ショップス出品ページの商品画像とブランドを取得
  function extractShopsInfo() {
    const info = { brand: '', name: '', price: 0, images: [], category: '', keyword: '' };
    const seen = new Set();
    document.querySelectorAll('img').forEach(im => {
      const s = (im.src || '').split('?')[0];
      if (!s || !/assets\.mercari-shops-static\.com/.test(s)) return;
      if (/icon|logo|avatar|sprite/i.test(s)) return;
      if (seen.has(s)) return;
      seen.add(s); info.images.push(s);
    });
    if (info.images.length > 10) info.images = info.images.slice(0, 10);
    // 商品説明(description)から「〇ブランド」の次行を取る
    const desc = (document.querySelector('textarea[name="description"]')?.value) || '';
    const bm = desc.match(/〇ブランド\s*\n\s*([^\n]+)/);
    if (bm) info.brand = bm[1].trim();
    return info;
  }

  // ブランディア商品ページの画像とブランドを取得
  function extractBrandearInfo() {
    const info = { brand: '', name: '', price: 0, images: [], category: '', keyword: '' };
    // メイン画像 = 最初に出てくる image1/0/数字_1.jpg (関連商品より前)
    for (const im of document.querySelectorAll('img')) {
      const s = (im.src || '').split('?')[0];
      if (/image1\/0\/\d+_1\.jpg/.test(s)) { info.images.push(s); break; }
    }
    // ブランド = title 先頭(例 "グレースコンチネンタル ワンピース サイズ38...")
    const t = (document.title || '').split(/[（(|｜]/)[0].trim();
    const head = t.split(/\s+/)[0] || '';
    if (head.length > 1) info.brand = head;
    return info;
  }

  // カインドオル商品ページの画像とブランドを取得(JSON-LD Product)
  function extractKindInfo() {
    const info = { brand: '', name: '', price: 0, images: [], category: '', keyword: '' };
    let ld = null;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let o; try { o = JSON.parse(s.textContent); } catch(e){ continue; }
      if (o && o['@type'] === 'Product') { ld = o; break; }
    }
    if (ld) {
      const img = Array.isArray(ld.image) ? ld.image[0] : ld.image;
      if (img) info.images.push(String(img).split('?')[0]);
      const d = ld.description || '';
      const b = (d.match(/【ブランド名】([^【]+)/) || [])[1] || '';
      if (b.trim().length > 1) info.brand = b.trim();
    }
    return info;
  }

  // ヤフオク商品ページの画像とブランドを取得(JSON-LD Product)
  function extractYahooInfo() {
    const info = { brand: '', name: '', price: 0, images: [], category: '', keyword: '' };
    let ld = null;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let o; try { o = JSON.parse(s.textContent); } catch(e){ continue; }
      if (o && o['@type'] === 'Product') { ld = o; break; }
    }
    if (ld) {
      const img = Array.isArray(ld.image) ? ld.image[0] : ld.image;
      if (img) info.images.push(String(img).split('?')[0]);
      const d = ld.description || '';
      const b = (d.match(/ブランド(.+?)タイプ/) || [])[1] || '';
      if (b.trim().length > 1) info.brand = b.trim();
    }
    // descriptionにブランド定型欄が無い出品はh1タイトル先頭2語で補う
    if (!info.brand) {
      const h1 = document.querySelector('h1');
      if (h1) {
        const parts = h1.textContent.replace(/[／/].*$/, '').trim().split(/\s+/);
        const cand = parts.slice(0, 2).join(' ').trim();
        if (cand.length > 1) info.brand = cand;
      }
    }
    return info;
  }


  // ============================================================
  // ② Lens 側 (オリジナル lens-scraper のID抽出ロジックを移植)
  // ============================================================
  async function initLens() {
    // storage不使用。セカスト由来のLensかは referrer で判定(実測: vsridリダイレクト後も
    // referrer=2ndstreet が残る)。セカスト由来でなければ既存フロー/通常Lens利用を邪魔しない。
    if (!/2ndstreet\.jp|mercari-shops\.com|brandear\.jp|kind\.co\.jp|yahoo\.co\.jp/.test(document.referrer)) return;
    if (window.__msqLensDone__) return; window.__msqLensDone__ = true;

    msqBadge('Lens結果を解析中...');
    const urls = await scrapeLensForMercari();
    let ids = [...new Set(urls.map(u => {
      const m = u.match(/\/item\/(m\d{10,13})/); return m ? m[1] : null;
    }).filter(Boolean))].slice(0, 40);  // bot回避のため上限40(90秒で取り切れる範囲)

    // カインドオル限定: ブランド不一致のLens結果を除外(別ブランド混入対策)
    if (/kind\.co\.jp/.test(document.referrer)) {
      const qRaw = (new URLSearchParams(location.search).get('q') || '')
        .replace(/##BACK##.*$/, '').replace(/\s*メルカリ\s*$/, '').trim();
      const bkeys = [];
      const bm = qRaw.match(/^(.*?)[（(]([^）)]*)[）)]/);
      if (bm) {
        if (bm[1].trim()) bkeys.push(bm[1].trim());
        if (bm[2].trim()) bkeys.push(bm[2].trim());
      } else if (qRaw) {
        bkeys.push(qRaw);
      }
      const nkeys = bkeys.map(k => k.toLowerCase().replace(/\s+/g, '')).filter(k => k.length >= 2);
      if (nkeys.length) {
        // Lens結果ページのa要素からID→タイトルのマップを作る
        const titleMap = {};
        document.querySelectorAll('a[href*="/item/m"]').forEach(a => {
          const mm = (a.href.match(/m\d{10,13}/) || [])[0];
          if (mm) titleMap[mm] = (titleMap[mm] || '') + ' ' + (a.textContent || '');
        });
        ids = ids.filter(id => {
          const t = titleMap[id];
          if (!t) return true;  // タイトル取得不可は安全側で残す
          const nt = t.toLowerCase().replace(/\s+/g, '');
          return nkeys.some(k => nt.includes(k));
        });
      }
    }

    // ヤフオク限定: ブランド不一致のLens結果を除外(qはスペース区切りの英+カナ)
    if (/yahoo\.co\.jp/.test(document.referrer)) {
      const qRaw = (new URLSearchParams(location.search).get('q') || '')
        .replace(/##BACK##.*$/, '').replace(/\s*メルカリ\s*$/, '').trim();
      const nkeys = qRaw.split(/\s+/)
        .map(k => k.replace(/\.$/, '').toLowerCase().replace(/＆/g, '&').trim())
        .filter(k => k.length >= 2);
      if (nkeys.length) {
        const titleMap = {};
        document.querySelectorAll('a[href*="/item/m"]').forEach(a => {
          const mm = (a.href.match(/m\d{10,13}/) || [])[0];
          if (mm) titleMap[mm] = (titleMap[mm] || '') + ' ' + (a.textContent || '');
        });
        ids = ids.filter(id => {
          const t = titleMap[id];
          if (!t) return true;  // タイトル取得不可は安全側で残す
          const nt = t.toLowerCase().replace(/\s+/g, '').replace(/＆/g, '&');
          return nkeys.some(k => nt.includes(k));
        });
      }
      console.log('[MSQ診断]ヤフオク照合後', ids.length, '件 / キー', JSON.stringify(nkeys));
      msqBadge('[診断]照合後' + ids.length + '件 キー' + JSON.stringify(nkeys));
    }

    if (!ids.length) { msqBadge('メルカリ該当なし。数秒後もう一度お試しを。'); return; }

    // 戻り先セカスト詳細URLを、Lens結果ページに写っているセカスト画像URLの
    //   goodsId(/goods/234538/40/97047/)から復元する。
    let backUrl = '';
    // 最優先: q に載せた ##BACK## 以降(Quetta+ショップスの下書きURL運搬)
    const qParam = new URLSearchParams(location.search).get('q') || '';
    const bm = qParam.match(/##BACK##(.+)$/);
    if (bm && /^https?:\/\//.test(bm[1])) {
      backUrl = bm[1];
    }
    // 次点: referrer(セカスト詳細/ショップス下書きURLが入る)
    const ref = document.referrer || '';
    if (!backUrl && (/2ndstreet\.jp\/goods\/detail/.test(ref) ||
        /mercari-shops\.com\/.*\/products\/(create|[^/]+\/edit)/.test(ref))) {
      backUrl = ref;
    }
    // フォールバック: Lens結果HTMLからセカストgoodsId復元
    if (!backUrl) {
      const html = document.body.innerHTML;
      let dm = html.match(
        /2ndstreet\.jp\/goods\/detail\/goodsId\/(\d+)(?:\/shopsId\/(\d+))?/);
      if (!dm) {
        const enc = html.match(
          /2ndstreet\.jp(?:%2F|%252F)goods(?:%2F|%252F)detail(?:%2F|%252F)goodsId(?:%2F|%252F)(\d+)(?:(?:%2F|%252F)shopsId(?:%2F|%252F)(\d+))?/i);
        if (enc) dm = enc;
      }
      if (dm) {
        backUrl = 'https://www.2ndstreet.jp/goods/detail/goodsId/' + dm[1] +
          (dm[2] ? '/shopsId/' + dm[2] : '');
      }
    }

    // キーワードはLensページのタイトル等から取れないため、
    // セカスト画像URLのファイル名は使えず、IDsのみの場合は従来動作。
    // セカスト由来ならreferrer遷移でsessionStorageは読めない(別オリジン)ので
    // キーワードはURLに載せられない→Lens結果ページ内のセカスト商品名は
    // 取得不能。よってキーワードなし時はids[0]検索を維持しつつ、
    // メルカリ側で全ID分のSOLDをDOM突き合わせで確定する方式に変更(差分3)。
    const merUrl = 'https://jp.mercari.com/search?keyword=' +
      encodeURIComponent(ids[0]) +
      '&__msq=1&__msqids=' + ids.join(',') +
      (backUrl ? '&__msqback=' + encodeURIComponent(backUrl) : '');

    // ★Quettaはスクリプトからの自動遷移(location.assign)を無視する。
    //  ユーザーのタップ由来の遷移なら通る(手動assignで実証済)。
    //  よって自動遷移せず、タップ用の大きなボタンをLensページに出す。
    showLensGoButton(ids.length, merUrl);
  }

  // Lensページに「メルカリで相場を見る」ボタンを出す(タップで遷移)
  function showLensGoButton(count, merUrl) {
    const old = document.getElementById('msq-golink'); if (old) old.remove();
    const a = document.createElement('a');
    a.id = 'msq-golink';
    a.href = merUrl;                     // aタグのnative遷移(タップ由来=Quettaで通る)
    a.textContent = '🛍 メルカリで相場を見る（' + count + '件）→';
    a.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'+
      'background:#2563eb;color:#fff;padding:18px;text-align:center;font:700 16px -apple-system,sans-serif;'+
      'text-decoration:none;box-shadow:0 -4px 12px rgba(0,0,0,.3);';
    document.documentElement.appendChild(a);
    const b = document.getElementById('msq-badge'); if (b) b.textContent = '🔍 メルカリ商品 ' + count + '件検出。下のボタンをタップ';
  }

    // メルカリで取得後「セカスト詳細に戻る(全結果を持ち帰る)」ボタン(タップ遷移)
    function showMercariBackButton(count, backWithResult) {
      const old = document.getElementById('msq-backlink'); if (old) old.remove();
      const a = document.createElement('a');
      a.id = 'msq-backlink';
      a.href = backWithResult;   // aタグnative遷移(タップ由来=Quetta通る)。fragmentに全結果
      const isShopsBack = /mercari-shops\.com/.test(backWithResult);
      const isBrandearBack = /brandear\.jp/.test(backWithResult);
      const isKindBack = /kind\.co\.jp/.test(backWithResult);
      const isYahooBack = /auctions\.yahoo\.co\.jp/.test(backWithResult);
      const backLabel = isShopsBack ? '← ショップス下書きに戻って相場を見る（'
        : isBrandearBack ? '← ブランディアに戻って相場を見る（'
        : isKindBack ? '← カインドオルに戻って相場を見る（'
        : isYahooBack ? '← ヤフオクに戻って相場を見る（'
        : '← セカストに戻って相場を見る（';
      a.textContent = backLabel + count + '件）';
      a.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'+
        'background:#7c3aed;color:#fff;padding:18px;text-align:center;font:700 16px -apple-system,sans-serif;'+
        'text-decoration:none;box-shadow:0 -4px 12px rgba(0,0,0,.3);';
      document.documentElement.appendChild(a);
    }

  // lens-scraper.js の抽出ロジック(完全移植・自動スクロール込み)
  async function scrapeLensForMercari() {
    let attempts = 0;
    const maxAttempts = 30;
    let best = [];
    let stable = 0;
    let lastH = 0;
    await sleep(700);
    while (attempts < maxAttempts) {
      attempts++;
      const beforeH = document.documentElement.scrollHeight;
      window.scrollTo(0, beforeH);
      await sleep(400);
      const afterH = document.documentElement.scrollHeight;
      const grew = afterH > beforeH;

      const urls = extractMercariUrls();
      if (urls.length > best.length) { best = urls; stable = 0; }
      else if (!grew) stable++;
      else stable = 0;

      // 早期終了を厳格化(取りこぼし防止): 最低8回スクロール後、
      // 高さも結果も伸びない状態が4回続いた時だけ打ち切る
      if (attempts >= 8 && stable >= 4 && !grew && afterH === lastH) break;
      lastH = afterH;
      if (attempts % 3 === 0) msqBadge('Lens解析中... ' + best.length + '件検出');

      const bt = document.body?.innerText || '';
      if (/No image at that URL|この URL には画像がありません|画像が見つかりませんでした|画像を読み込めません/.test(bt)) break;
      if (/Sign in|ログイン|reCAPTCHA|認証/.test(bt) && bt.length < 2000) break;
      if (attempts >= 12 && best.length === 0) {
        if (extractAllResultUrls().length > 0) break;
      }
    }
    return best;
  }

  function extractMercariUrls() {
    const urls = [], seen = new Set();
    const addId = (id) => {
      if (!id || seen.has(id) || !/^m\d{10,}$/.test(id)) return;
      seen.add(id); urls.push('https://jp.mercari.com/item/' + id);
    };
    const html = document.body?.innerHTML || '';
    const patterns = [
      /https?:\/\/(?:jp\.|www\.)?mercari\.com\/item\/(m\d{10,})/g,
      /mercari\.com[%/]item[%/](m\d{10,})/gi,
      /mercari(?:\.|%2E)com(?:\/|%2F)item(?:\/|%2F)(m\d{10,})/gi,
      /jp%2Emercari%2Ecom%2Fitem%2F(m\d{10,})/gi,
      /"itemId"\s*:\s*"(m\d{10,})"/g,
      /"id"\s*:\s*"(m\d{10,})"/g,
    ];
    for (const re of patterns) { let m; while ((m = re.exec(html)) !== null) addId(m[1]); }
    document.querySelectorAll('a[href], [data-url], [data-action-url]').forEach(a => {
      const href = a.href || a.getAttribute('href') || '';
      const dataHref = a.getAttribute('data-action-url') || a.getAttribute('data-url') || a.getAttribute('ping') || '';
      [href, dataHref].forEach(u => {
        if (!u) return;
        let dec = u; try { dec = decodeURIComponent(u); } catch (e) {}
        const m = dec.match(/mercari\.com\/item\/(m\d{10,})/); if (m) addId(m[1]);
      });
    });
    document.querySelectorAll('a[href*="google.com/url"], a[href*="/url?"], a[href*="imgres"]').forEach(a => {
      const href = a.href || '';
      const pr = /[?&](?:url|q|imgrefurl|ru|target)=([^&]+)/g; let pm;
      while ((pm = pr.exec(href)) !== null) {
        try { const dec = decodeURIComponent(pm[1]); const m = dec.match(/mercari\.com\/item\/(m\d{10,})/); if (m) addId(m[1]); } catch (e) {}
      }
    });
    document.querySelectorAll('cite, [class*="url"], [class*="cite"], [class*="source"], [class*="domain"]').forEach(el => {
      const m = (el.textContent || '').match(/mercari\.com\/item\/(m\d{10,})/); if (m) addId(m[1]);
    });
    return urls;
  }

  function extractAllResultUrls() {
    const urls = [], seen = new Set();
    const sels = ['a[class*="ngTNl"]', 'a[class*="ggLgoc"]', 'a[class*="GZrdsf"]', '.G19kAf a', '.Vd9M6 a', 'a[data-action-url]'];
    for (const sel of sels) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const href = el.href || el.getAttribute('data-action-url') || '';
          if (href && href.startsWith('http') && !seen.has(href)) { seen.add(href); urls.push(href); }
        });
      } catch (e) {}
    }
    if (urls.length === 0) {
      document.querySelectorAll('a[href^="http"]').forEach(a => {
        const href = a.href || '';
        if (href && !href.includes('google.com') && !href.includes('lens.google') &&
            !href.includes('gstatic') && !href.includes('googleapis') && !seen.has(href)) { seen.add(href); urls.push(href); }
      });
    }
    return urls;
  }

  // ============================================================
  // ③ メルカリ側 (オリジナルの fetchSingleItem/parseItemPage/
  //    fetchMercariSearchIds/calculateSummary を同一オリジンで再現)
  // ============================================================
  async function initMercari() {
    // storage不使用。ID群はURL __msqids= から受け取る。自分由来判定は __msq=1。
    const sp = new URLSearchParams(location.search);
    if (sp.get('__msq') !== '1') return;  // 通常のメルカリ利用は邪魔しない
    if (window.__msqMerDone__) return; window.__msqMerDone__ = true;

    const idsStr = sp.get('__msqids') || '';
    const ids = [...new Set(idsStr.split(',').filter(x => /^m\d{10,13}$/.test(x)))];
    const backUrl = sp.get('__msqback') || 'https://www.2ndstreet.jp/';
    const payload = { images: [], brand: '', name: '', keyword: '', backUrl };

    injectStyle();
    showOverlay(payload, null);
    setTimeout(()=>msqLog('Lens検出 ' + ids.length + '件。bot回避のため間隔を空けて取得します...'),50);

    // SOLD判定はSSRから取れないため行わない(価格の幅のみ表示)
    const soldMap = {};
    const knownMap = {};

    // bot回避: 並列2 + 1件ごと200〜400msゆらぎ + 90秒打ち切り + CF検知で即停止
    const items = await fetchItemsThrottled(ids, soldMap);

    msqLog('完了: ' + items.length + '件取得。元のタブに結果を返します。');
    const packed = items.map(it => ({
      i: it.id, p: it.price, c: condClass(it.condition),
      t: (it.name||'').slice(0, 40), h: it.thumbnail || ''
    }));

    // 結果を chrome.storage.local に書く(オリジン跨ぎ共有)。元タブがonChangedで受ける。
    if (MSQ_IS_MOBILE) {
      // Quetta等: fragmentに結果を載せて元ページ(backUrl)へ同タブ遷移
      msqLog('結果を持って元ページに戻ります。');
      let payloadStr = '';
      try {
        payloadStr = encodeURIComponent(JSON.stringify(packed));
        if (payloadStr.length > 30000) {
          const slim = packed.map(o => ({ i:o.i, p:o.p, c:o.c, t:(o.t||'').slice(0,25) }));
          payloadStr = encodeURIComponent(JSON.stringify(slim));
        }
      } catch(e){}
      const sep = backUrl.includes('#') ? '&' : '#';
      const back = backUrl + sep + '__msqresult=' + payloadStr;
      // タップ由来遷移が要るQuetta向けに、戻るボタンを出す(自動assignは弾かれるため)
      showMercariBackButton(items.length, back);
      const summary = calculateSummary(items);
      showOverlay(payload, { items, summary, error: items.length ? null : 'メルカリ該当なし' });
      return;
    }
    // PC Chrome: storageに書いて新タブを閉じる
    msqLog('結果を保存して元タブに通知します。');
    try {
      chrome.storage.local.set({ msq_result: { items: packed, ts: Date.now() } }, () => {
        msqLog('保存完了。このタブを閉じます。');
        setTimeout(() => { try { window.close(); } catch(e){} }, 400);
      });
    } catch(e) {
      const summary = calculateSummary(items);
      showOverlay(payload, { items, summary, error: items.length ? null : 'メルカリ該当なし' });
    }
    return;
  }

  // bot回避スロットル付き取得。90秒予算、並列2、ゆらぎ間隔、CF検知で停止。
  async function fetchItemsThrottled(ids, soldMap) {
    const out = [];
    const deadline = Date.now() + 90000;
    const queue = [...ids];
    let stopped = false;
    let done = 0;
    const jitter = () => 200 + Math.floor(Math.random() * 200); // 200〜400ms
    async function worker() {
      while (queue.length && !stopped) {
        if (Date.now() > deadline) { stopped = true; msqLog('⏱ 90秒到達。取得を打ち切ります。'); break; }
        const id = queue.shift();
        if (!id) continue;
        try {
          const it = await fetchSingleItem(id);
          if (it === 'CF') { stopped = true; msqLog('⚠ bot判定(CF)検知。安全のため停止しました。'); break; }
          if (it) { out.push(it); }
        } catch (e) {}
        done++;
        if (done % 5 === 0) msqLog('取得中... ' + out.length + '件 (残 ' + queue.length + ')');
        await sleep(jitter());
      }
    }
    await Promise.all([worker(), worker()]); // 並列2
    return out;
  }

  // 個別ページを同一オリジンfetch(5並列)
  async function fetchMercariItems(ids) {
    const CONCURRENCY = 5;
    const results = [];
    const queue = [...ids];
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        if (!id) continue;
        try { const it = await fetchSingleItem(id); if (it) results.push(it); } catch (e) {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return results;
  }

  async function fetchSingleItem(itemId) {
    const url = 'https://jp.mercari.com/item/' + itemId;
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' },
      credentials: 'omit'  // オリジナル通り(CF/bot回避)
    });
    if (res.status === 429 || res.status === 403) return 'CF';  // レート制限/bot判定
    if (!res.ok) return null;
    const html = await res.text();
    if (/cf-browser-verification|Just a moment|attention required|challenge-platform/i.test(html)) return 'CF';
    if (html.length < 1000) return null;
    return parseItemPage(html, itemId, url);
  }

  function decodeEntities(s) {
    const d = document.createElement('textarea'); d.innerHTML = s; return d.value;
  }

  function parseItemPage(html, itemId, url) {
    const item = { id: itemId, name: '', price: 0, thumbnail: '', url, isSold: false, likes: 0, condition: '' };
    const getMeta = (key) => {
      const r1 = new RegExp('<meta[^>]*(?:property|name)=["\']' + key + '["\'][^>]*content=["\']([^"\']+)["\']', 'i');
      const r2 = new RegExp('<meta[^>]*content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + key + '["\']', 'i');
      const m = html.match(r1) || html.match(r2);
      return m ? decodeEntities(m[1]) : '';
    };
    const ogTitle = getMeta('og:title');
    if (ogTitle) item.name = ogTitle.replace(/\s*[-–]\s*メルカリ.*$/, '').replace(/\s+/g, ' ').trim();
    item.thumbnail = getMeta('og:image');
    const ogPrice = getMeta('product:price:amount');
    if (ogPrice) { const p = parseInt(ogPrice.replace(/[^\d]/g, ''), 10); if (p > 0) item.price = p; }

    // 削除/非表示判定: 商品画像URL preload と価格が無ければ除外
    const hasItemImage = html.includes('/photos/' + itemId + '_');
    if (!hasItemImage || item.price === 0) return null;

    item.isSold = null;  // SSRにSOLD情報が無いため判定しない(価格の幅のみ表示)

    const lm = html.match(/"numLikes"\s*:\s*(\d+)/) || html.match(/"likes"\s*:\s*(\d+)/);
    if (lm) item.likes = parseInt(lm[1], 10);
    const cm = html.match(/"itemConditionText"\s*:\s*"([^"]+)"/) ||
               html.match(/"itemCondition"\s*:\s*"([^"]+)"/) ||
               html.match(/"condition"\s*:\s*"([^"]+)"/);
    if (cm) item.condition = cm[1];
    return item;
  }

  // 自動スクロールしながら検索DOMを収集(最大10秒)
  async function scrapeSearchDomDeep() {
    let best = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const cur = await scrapeSearchDom();
      if (cur.length > best.length) best = cur;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(600);
      const again = await scrapeSearchDom();
      if (again.length > best.length) best = again;
      else break;
    }
    window.scrollTo(0, 0);
    return best;
  }

  // 検索結果ページのDOMから id + SOLD を抽出(自分のページなのでそのまま読む)
  async function scrapeSearchDom() {
    for (let i = 0; i < 15; i++) {
      if (document.querySelector('li[data-testid="item-cell"] .merItemThumbnail[id^="m"]') ||
          document.querySelector('a[href*="/item/m"]')) break;
      await sleep(200);
    }
    const itemMap = new Map();
    const mark = (id, isSold) => {
      if (!/^m\d{10,13}$/.test(id)) return;
      if (itemMap.has(id)) { if (isSold) itemMap.set(id, true); }
      else itemMap.set(id, isSold);
    };
    document.querySelectorAll('li[data-testid="item-cell"], [data-testid="item-cell"]').forEach(cell => {
      const thumb = cell.querySelector('.merItemThumbnail[id^="m"]') || cell.querySelector('[id^="m"][itemtype]');
      let id = (thumb && thumb.id) || '';
      if (!/^m\d{10,13}$/.test(id)) {
        const a = cell.querySelector('a[href*="/item/m"]');
        const m = a && (a.getAttribute('href') || '').match(/\/item\/(m\d{10,13})/);
        if (m) id = m[1];
      }
      if (!/^m\d{10,13}$/.test(id)) return;
      const aria = (thumb && thumb.getAttribute('aria-label')) || '';
      const isSold = !!cell.querySelector('[data-testid="thumbnail-sticker"][aria-label*="売り切れ"], [class*="sticker"][aria-label*="売り切れ"]') || /売り切れ/.test(aria);
      mark(id, isSold);
    });
    document.querySelectorAll('a[href*="/item/m"]').forEach(a => {
      const m = (a.href || a.getAttribute('href') || '').match(/\/item\/(m\d{10,13})/);
      if (!m) return;
      const thumb = a.querySelector('.merItemThumbnail[aria-label], [aria-label*="売り切れ"]');
      const aria = (thumb && thumb.getAttribute('aria-label')) || '';
      mark(m[1], /売り切れ/.test(aria));
    });
    return [...itemMap.entries()].map(([id, isSold]) => ({ id, isSold }));
  }

  // step2: 未確定商品を個別ページHTMLのJSON状態で確定
  async function confirmStatusViaFetch(list) {
    const CONCURRENCY = 5;
    const queue = [...list];
    async function worker() {
      while (queue.length) {
        const it = queue.shift();
        if (!it) continue;
        try {
          const res = await fetch('https://jp.mercari.com/item/' + it.id, { credentials: 'omit' });
          if (!res.ok) continue;
          const html = await res.text();
          if (/schema\.org\/SoldOut/.test(html)) { it.isSold = true; it._src = 'fetch'; }
          else if (/schema\.org\/InStock/.test(html)) { it.isSold = false; it._src = 'fetch'; }
        } catch (e) {}
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  function calculateSummary(items) {
    const allP = items.map(i => i.price).filter(p => p > 0).sort((a,b)=>a-b);
    const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
    const median = a => a.length ? a[Math.floor(a.length/2)] : 0;
    return {
      total: items.length,
      onSale: 0, soldOut: 0,
      avgPrice: avg(allP), avgSoldPrice: 0,
      medianPrice: median(allP),
      minPrice: allP.length ? allP[0] : 0,
      maxPrice: allP.length ? allP[allP.length-1] : 0
    };
  }
  function emptySummary() { return { total: 0, onSale: 0, soldOut: 0, avgPrice: 0, avgSoldPrice: 0, minPrice: 0, maxPrice: 0 }; }

  // ============================================================
  // 商品情報抽出 / キーワード生成 (オリジナル完全移植)
  // ============================================================
  function msqExtractInfo() {
    const info = { brand: '', name: '', price: 0, images: [], category: '' };
    const brandNG = /^(クリア|Clear|TOP|Top|HOME|Home|ホーム|2nd STREET|2ndstreet|メンズ|レディース|レディースウェア|メンズウェア|キッズ|キッズウェア|ベビー|検索|絞り込み|並べ替え|並び替え|全て|すべて|送料無料|新着|セール|お気に入り|カート|商品詳細|商品一覧|買いたい|売りたい|店舗を探す|カテゴリ|カットソー|トップス|ボトムス|アウター|シャツ|Tシャツ|パンツ|スカート|ワンピース|ドレス|ジャケット|コート|バッグ|シューズ|アクセサリー|お問い合わせ|MY|MyPage)$/i;
    const isValidBrand = (t) => t && t.length > 1 && t.length < 80 && !brandNG.test(t);
    // 最優先: document.title からブランド抽出(Quettaでog:title/パンくずが取れない対策)
    //   例 "Supreme(シュプリーム) / Tシャツ/M/コットン/GRY// | 古着の販売..."
    {
      const dt = (document.title || '').split(/[|｜]/)[0];
      const head = dt.split(/[／/（(]/)[0].trim();  // "Supreme"
      if (isValidBrand(head)) info.brand = head;
      // 商品名も title から(先頭ブロック全体)
      const nm = dt.replace(/\s+/g, ' ').trim();
      if (nm.length > 1) info.name = nm;
    }
    if (!info.brand) {
      const crumbs = Array.from(document.querySelectorAll('.breadcrumb a, .breadcrumbList a, [class*="breadcrumb"] a, [class*="Breadcrumb"] a, .pankuzu a, [class*="pankuzu"] a, nav a'))
        .map(a => (a.textContent || '').trim())
        .filter(t => isValidBrand(t) && !/^(買いたい|売りたい|店舗を探す|商品詳細|商品一覧)$/.test(t));
      for (const c of crumbs) { if (/[A-Za-z]/.test(c) && !/^https?:/.test(c)) { info.brand = c; break; } }
      if (!info.brand && crumbs.length >= 2) info.brand = crumbs[1] || crumbs[0];
    }
    if (!info.brand) {
      for (const el of document.querySelectorAll('a[href*="/brand/"], a[href*="brandsId="]')) {
        const t = (el.textContent || '').trim(); if (isValidBrand(t)) { info.brand = t; break; }
      }
    }
    if (!info.brand) {
      const bs = ['.goodsBrandArea a', '.goodsBrandArea', '.brandName a', '.brandName', '.brand-name a', '.brand-name', '.itemBrand a', '.itemBrand', '.goodsInfoBrand a', '.goodsInfoBrand', '[data-brand]'];
      for (const s of bs) { try { const el = document.querySelector(s); if (el) { const t = (el.textContent || el.getAttribute('data-brand') || '').trim(); if (isValidBrand(t)) { info.brand = t; break; } } } catch (e) {} }
    }
    if (!info.brand) {
      document.querySelectorAll('th, dt, .label, .spec-label').forEach(el => {
        if (info.brand) return;
        if (/^(ブランド|メーカー|ブランド名)$/.test((el.textContent || '').trim())) {
          const v = el.nextElementSibling; if (v) { const a = v.querySelector('a'); const t = ((a || v).textContent || '').trim(); if (isValidBrand(t)) info.brand = t; }
        }
      });
    }
    if (!info.brand) {
      const og = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
      const m = og.match(/^([A-Za-z][A-Za-z0-9\s=&\-'.]+?)(?=\s*[／/｜|・(（]|\s+[ぁ-んァ-ヶ一-龯T])/);
      if (m && isValidBrand(m[1].trim())) info.brand = m[1].trim();
    }
    {
      const og = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
      if (og) {
        let t = og.split(/[|｜]/)[0].trim();
        t = t.replace(/\([^)]+\)/g, '').replace(/（[^）]+）/g, '').trim().replace(/\s+/g, ' ').trim();
        if (t.length > 1) info.name = t;
      }
    }
    if (!info.name) {
      const ns = ['h1.goodsName', '.goodsName', 'h1.itemName', '.itemName', 'h1[class*="goods"]', 'h1[class*="product"]', '.goodsTitle', '.item-name', '.productName', 'main h1', 'h1'];
      for (const s of ns) { try { const el = document.querySelector(s); if (el) { const t = (el.textContent || '').trim(); if (t.length > 1) { info.name = t; break; } } } catch (e) {} }
    }
    const ps = ['.goodsPrice .num', '.goodsPrice', '.itemPrice .num', '.itemPrice', '.salesPrice', '.price .num'];
    for (const s of ps) { try { const el = document.querySelector(s); if (el) { const t = (el.textContent || '').replace(/[^0-9]/g, ''); if (t) { info.price = parseInt(t, 10); break; } } } catch (e) {} }

    const ogImgRaw = (document.querySelector('meta[property="og:image"]')?.content || '').split('?')[0];
    const normalizeUrl = (u) => u.replace(/_(tn|mn|sm|small|thumb|sml|sma|s|m)(\.[a-z]+)$/i, '$2').replace(/\/thumb\//, '/');
    const ogImg = ogImgRaw ? normalizeUrl(ogImgRaw) : '';
    let mainGoodsId = '';
    if (ogImg) { const m = ogImg.match(/\/goods\/([0-9]+\/[0-9]+\/[0-9]+)/); if (m) mainGoodsId = m[1]; }
    const idCounts = {};
    document.querySelectorAll('img, picture source[srcset]').forEach(el => {
      const cands = [el.getAttribute('src') || '', el.getAttribute('data-src') || '', el.getAttribute('data-original') || '', (el.getAttribute('srcset') || '').split(' ')[0]];
      for (const s of cands) { const mm = s.match(/\/goods\/([0-9]+\/[0-9]+\/[0-9]+)/); if (mm) { idCounts[mm[1]] = (idCounts[mm[1]] || 0) + 1; break; } }
    });
    let topId = '', topCount = 0;
    const sorted = Object.entries(idCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length) { topId = sorted[0][0]; topCount = sorted[0][1]; }
    if (!mainGoodsId || (idCounts[mainGoodsId] || 0) < 2) { if (topId && topCount >= 2) mainGoodsId = topId; }

    const seen = new Set();
    const addImg = (el) => {
      let src = el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('srcset')?.split(' ')[0] || el.getAttribute('src') || '';
      src = src.split('?')[0];
      if (!src || !src.startsWith('http')) return;
      if (/noimage|logo|icon|sprite|banner|placeholder/i.test(src)) return;
      const full = normalizeUrl(src);
      if (mainGoodsId && full.includes('/goods/') && !full.includes('/goods/' + mainGoodsId + '/')) return;
      if (seen.has(full)) return; seen.add(full); info.images.push(full);
    };
    if (ogImg) { seen.add(ogImg); info.images.push(ogImg); }
    const gcs = ['#goodsDetail .swiper', '#goodsDetail .slick-slider', '.goodsDetail .swiper', '.goodsDetail .slick-slider', '.goodsImgArea', '.goodsImageArea', '.itemImageArea', '[class*="goodsImage"]', '[class*="itemImage"]', '[class*="ProductImage"]', '[class*="ProductGallery"]'];
    for (const cs of gcs) { try { const c = document.querySelector(cs); if (c) c.querySelectorAll('img, picture source[srcset]').forEach(addImg); } catch (e) {} }
    if (info.images.length <= 1 && mainGoodsId) { try { document.querySelectorAll('main img, main picture source[srcset]').forEach(addImg); } catch (e) {} }
    if (info.images.length === 0 && ogImg) info.images.push(ogImg);
    if (info.images.length > 10) info.images = info.images.slice(0, 10);

    const bc = [];
    document.querySelectorAll('.breadcrumb a, .breadcrumbList a, [class*="breadcrumb"] a, .pankuzu a, [class*="pankuzu"] a').forEach(a => {
      const t = (a.textContent || '').trim(); if (t && t !== 'TOP' && t !== 'ホーム' && t !== '2nd STREET') bc.push(t);
    });
    info.category = bc.join(' > ');
    try { window.__msqDebugBrand = info.brand; } catch(e){}
    return info;
  }

  const SUBLINE_PATTERN = /\s+(RED\s*LABEL|GOLD\s*LABEL|BLUE\s*LABEL|BLACK\s*LABEL|MAN\s*LINE|ANGLOMANIA|MAGLIA|RECYCLE\s*LABEL|JEANS|MAN|MEN|WOMAN|WOMEN|KIDS|HOMME|FEMME)$/i;
  const CATEGORY_TOKENS = ['タンクトップ','Tシャツ','ロンT','カットソー','ブラウス','シャツ','ポロシャツ','パーカー','パーカ','スウェット','トレーナー','カーディガン','ニット','セーター','ベスト','リバースウィーブ','ジャケット','ブルゾン','コート','ダウン','マウンテンパーカ','ナイロンジャケット','パンツ','ジーンズ','デニム','スラックス','チノパン','ショートパンツ','スカート','ワンピース','ドレス','セットアップ','バッグ','リュック','トート','クラッチ','ハンドバッグ','ボディバッグ','スニーカー','ブーツ','パンプス','サンダル','ローファー','シューズ'];

  function buildKeyword(info) {
    let brand = (info.brand || '').replace(SUBLINE_PATTERN, '').trim();
    let nameRaw = (info.name || '')
      .replace(/【[^】]*】/g, '').replace(/\[[^\]]*\]/g, '')
      .replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '')
      .replace(/セカンドストリート/g, '').replace(/2nd\s*STREET/gi, '')
      .replace(/中古|送料無料|USED|新品同様/gi, '').replace(/\s+/g, ' ').trim();
    if (info.brand) nameRaw = nameRaw.replace(new RegExp(info.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
    if (brand && brand !== info.brand) nameRaw = nameRaw.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
    let category = '';
    for (const tok of [...CATEGORY_TOKENS].sort((a, b) => b.length - a.length)) { if (nameRaw.includes(tok)) { category = tok; break; } }
    if (brand && category) return (brand + ' ' + category).trim();
    if (brand) { let tail = nameRaw.replace(/\s+/g, '').slice(-10).trim(); return tail ? (brand + ' ' + tail).trim() : brand; }
    if (category) return category;
    return nameRaw || (document.title || '').replace(/[|｜].*$/, '').replace(/セカンドストリート.*$/i, '').trim();
  }

  // ============================================================
  // オーバーレイ UI (メルカリページ上に表示)
  // ============================================================
  let currentItems = null, currentFilter = 'all', currentSort = 'price-desc', currentExcludeNew = false, currentCond = 'all';

  function showOverlay(payload, results) {
    const ex = document.getElementById('msq-overlay'); if (ex) ex.remove();
    const ov = document.createElement('div');
    ov.id = 'msq-overlay';
    const isLoading = results === null;
    const imgs = (payload.images || []).slice(0, 10);
    ov.innerHTML = `
      <div class="msq-panel">
        <div class="msq-header">
          <div class="msq-title"><span>🔍</span><span>メルカリサーチ</span></div>
          <button class="msq-close" id="msq-close">✕</button>
        </div>
        <div class="msq-info">
          ${imgs.length ? `<div class="msq-thumbs">${imgs.map((im,i)=>`<div class="msq-thumb ${i===0?'msq-thumb-active':''}"><img src="${esc(im)}"></div>`).join('')}</div>` : ''}
          <div class="msq-mode">🔍 画像検索</div>
          <div class="msq-back-row">
            <input class="msq-kw" id="msq-kw" type="text"
              placeholder="キーワードを入力" value="${esc(payload.keyword||'')}">
            <button class="msq-open-btn" id="msq-open">メルカリ通常検索</button>
            ${IS_HOST ? '' :
              '<button class="msq-back-btn" id="msq-back">← 戻る</button>'}
          </div>
        </div>
        <div class="msq-body">${isLoading ? renderLoading() : renderResults(results)}</div>
      </div>`;
    document.body.appendChild(ov);
    setupOverlayEvents(ov, payload);
  }

  function renderLoading() {
    return `<div class="msq-loading"><div class="msq-spinner"></div><p>💎 メルカリで類似品をハント中...</p><p class="msq-loading-hint">あと少しでお値段が判明します ✨</p><div class="msq-log" id="msq-log"></div></div>`;
  }
  function msqLog(t){const b=document.getElementById('msq-log');const l='[' + new Date().toLocaleTimeString('ja-JP') + '] ' + t;if(b){const p=document.createElement('div');p.textContent=l;b.appendChild(p);b.scrollTop=b.scrollHeight;}try{console.log('[MSQ]',t);}catch(e){}}
  // Lensページ用の画面バッジ(オーバーレイが無い遷移先で進捗表示)
  function msqBadge(t){let el=document.getElementById('msq-badge');if(!el){el=document.createElement('div');el.id='msq-badge';el.style.cssText='position:fixed;left:10px;bottom:10px;z-index:2147483647;background:#2563eb;color:#fff;padding:10px 14px;border-radius:10px;font:13px -apple-system,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:90vw;';document.documentElement.appendChild(el);}el.textContent='🔍 メルカリサーチ: '+t;try{console.log('[MSQ]',t);}catch(e){}}

  function renderResults(data) {
    if (data.error && (!data.items || !data.items.length)) {
      return `<div class="msq-no-results"><p>⚠️ ${esc(data.error)}</p><p class="msq-error-hint">「メルカリ通常検索」も試せます。</p></div>`;
    }
    if (!data.items || !data.items.length) {
      return `<div class="msq-no-results"><p>🔍 メルカリの商品が見つかりませんでした</p></div>`;
    }
    currentItems = data.items;
    const filtered = applyFilterSort(currentItems);
    const s = data.summary;
    return `
      <div class="msq-summary" id="msq-summary">
        <div class="msq-stat"><span class="msq-stat-label">平均</span><span class="msq-stat-value">¥${(s.avgPrice||0).toLocaleString()}</span></div>
        <div class="msq-stat"><span class="msq-stat-label">中央値</span><span class="msq-stat-value">¥${(s.medianPrice||0).toLocaleString()}</span></div>
        <div class="msq-stat"><span class="msq-stat-label">件数</span><span class="msq-stat-value">${s.total}件</span></div>
        ${s.minPrice>0?`<div class="msq-stat msq-stat-wide"><span class="msq-stat-label">価格帯</span><span class="msq-stat-value">¥${s.minPrice.toLocaleString()} 〜 ¥${s.maxPrice.toLocaleString()}</span></div>`:''}
      </div>
      <div class="msq-results-header">
        <span id="msq-results-count">検索結果 (${filtered.length}件 / 全${currentItems.length}件)</span>
        <div class="msq-controls">
          <button class="msq-toggle-btn ${currentExcludeNew?'active':''}" id="msq-exclude-new">🚫 新品除外</button>
          <select class="msq-sort-select" id="msq-cond">
            <option value="all" ${currentCond==='all'?'selected':''}>状態:すべて</option>
            <option value="new" ${currentCond==='new'?'selected':''}>新品</option>
            <option value="likenew" ${currentCond==='likenew'?'selected':''}>未使用に近い</option>
            <option value="good" ${currentCond==='good'?'selected':''}>目立った傷なし</option>
            <option value="fair" ${currentCond==='fair'?'selected':''}>やや傷あり</option>
            <option value="poor" ${currentCond==='poor'?'selected':''}>傷あり</option>
          </select>
          <select class="msq-sort-select" id="msq-sort">
            <option value="price-desc" ${currentSort==='price-desc'?'selected':''}>高い順</option>
            <option value="price-asc" ${currentSort==='price-asc'?'selected':''}>安い順</option>
            <option value="default" ${currentSort==='default'?'selected':''}>表示順</option>
            <option value="likes" ${currentSort==='likes'?'selected':''}>いいね順</option>
          </select>
        </div>
      </div>
      <div class="msq-items" id="msq-items">${filtered.map(renderCard).join('')}</div>`;
  }

  function applyFilterSort(items) {
    let f = items;
    if (currentFilter === 'sold') f = f.filter(i => i.isSold === true);
    else if (currentFilter === 'onsale') f = f.filter(i => i.isSold === false);
    if (currentCond !== 'all') f = f.filter(i => condClass(i.condition) === currentCond);
    if (currentExcludeNew) f = f.filter(i => !isNewish(i.condition));
    f = [...f];
    if (currentSort === 'price-asc') f.sort((a, b) => (a.price||0)-(b.price||0));
    else if (currentSort === 'price-desc') f.sort((a, b) => (b.price||0)-(a.price||0));
    else if (currentSort === 'likes') f.sort((a, b) => (b.likes||0)-(a.likes||0));
    return f;
  }

  function rerenderItems() {
    const el = document.getElementById('msq-items'), c = document.getElementById('msq-results-count');
    if (!el || !currentItems) return;
    const f = applyFilterSort(currentItems);
    el.innerHTML = f.map(renderCard).join('');
    if (c) c.textContent = `検索結果 (${f.length}件 / 全${currentItems.length}件)`;
    attachItemHandlers(); recalcSummary();
  }

  function renderCard(item) {
    const newish = isNewish(item.condition);
    return `
      <div class="msq-item-card" data-url="${esc(item.url)}" data-price="${item.price}">
        <button class="msq-exclude-btn">✕</button>
        <div class="msq-item-image">
          ${item.thumbnail?`<img src="${esc(item.thumbnail)}" loading="lazy" onerror="this.style.display='none'">`:'<div class="msq-no-image">No Image</div>'}
          ${newish?`<span class="msq-status-new">新品</span>`:''}
        </div>
        <div class="msq-item-info">
          <p class="msq-item-name" title="${esc(item.name)}">${esc(item.name||'')}</p>
          <p class="msq-item-price">¥${item.price.toLocaleString()}</p>
          ${item.likes?`<p class="msq-item-likes">♥ ${item.likes}</p>`:''}
          ${item.condition?`<p class="msq-item-condition ${newish?'msq-item-condition-new':''}">${esc(item.condition)}</p>`:''}
        </div>
      </div>`;
  }

  function attachItemHandlers() {
    document.querySelectorAll('#msq-items .msq-item-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.msq-exclude-btn')) return;
        if (card.dataset.url) window.open(card.dataset.url, '_blank');
      });
    });
    document.querySelectorAll('#msq-items .msq-exclude-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const card = btn.closest('.msq-item-card');
        card.style.opacity = '0'; card.style.transform = 'scale(0.95)';
        setTimeout(() => { card.remove(); recalcSummary(); }, 200);
      });
    });
  }

  function recalcSummary() {
    const cards = [...document.querySelectorAll('#msq-items .msq-item-card')];
    const prices = cards.map(c => parseInt(c.dataset.price, 10)).filter(p => p > 0);
    const sold = cards.filter(c => c.dataset.isSold === 'true').map(c => parseInt(c.dataset.price, 10)).filter(p => p > 0);
    const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
    const sum = document.getElementById('msq-summary'); if (!sum) return;
    const median = a => { const s=[...a].sort((x,y)=>x-y); return s.length?s[Math.floor(s.length/2)]:0; };
    const vals = sum.querySelectorAll('.msq-stat-value');
    if (vals[0]) vals[0].textContent = '¥' + avg(prices).toLocaleString();
    if (vals[1]) vals[1].textContent = '¥' + median(prices).toLocaleString();
    if (vals[2]) vals[2].textContent = cards.length + '件';
  }

  function setupOverlayEvents(ov, payload) {
    document.getElementById('msq-close')?.addEventListener('click', () => ov.remove());
    document.getElementById('msq-back')?.addEventListener('click', () => {
      if (payload.backUrl) location.assign(payload.backUrl);
    });
    document.getElementById('msq-open')?.addEventListener('click', () => {
      const kw = (document.getElementById('msq-kw')?.value || '').trim();
      if (!kw) { alert('キーワードを入力してください'); return; }
      location.assign('https://jp.mercari.com/search?keyword=' +
        encodeURIComponent(kw));
    });
    attachItemHandlers();
    ov.querySelectorAll('.msq-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        ov.querySelectorAll('.msq-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active'); currentFilter = btn.dataset.filter; rerenderItems();
      });
    });
    document.getElementById('msq-sort')?.addEventListener('change', e => { currentSort = e.target.value; rerenderItems(); });
    document.getElementById('msq-cond')?.addEventListener('change', e => { currentCond = e.target.value; rerenderItems(); });
    document.getElementById('msq-exclude-new')?.addEventListener('click', e => {
      currentExcludeNew = !currentExcludeNew; e.currentTarget.classList.toggle('active', currentExcludeNew); rerenderItems();
    });
  }

  // ============================================================
  // CSS (オレンジ全廃 → 青 #2563eb / 紫 #7c3aed)
  // ============================================================
  function injectStyle() {
    if (document.getElementById('msq-style')) return;
    const st = document.createElement('style');
    st.id = 'msq-style';
    st.textContent = `
      #msq-fab { position: fixed; left: 16px; bottom: 80px; z-index: 2147483600;
        background: #7c3aed; color: #fff; border: none; border-radius: 24px;
        padding: 12px 18px; font-size: 14px; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,.25); }
      #msq-overlay { position: fixed; right: 0; top: 0; bottom: 0; z-index: 2147483601;
        width: min(420px,100vw); display: flex; }
      #msq-overlay .msq-panel { background: #fff; width: 100%; height: 100%;
        display: flex; flex-direction: column; box-shadow: -4px 0 16px rgba(0,0,0,.2);
        font-family: -apple-system, sans-serif; font-size: 13px; color: #111; }
      .msq-header { display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; background: #2563eb; color: #fff; }
      .msq-title { font-weight: 800; font-size: 15px; display: flex; gap: 6px; align-items: center; }
      .msq-close { background: rgba(255,255,255,.25); border: none; color: #fff;
        width: 28px; height: 28px; border-radius: 14px; cursor: pointer; font-size: 14px; }
      .msq-info { padding: 8px 14px; }
      .msq-thumbs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; }
      .msq-thumb { flex: 0 0 auto; width: 48px; height: 48px; border-radius: 6px;
        overflow: hidden; border: 2px solid transparent; }
      .msq-thumb-active { border-color: #7c3aed; }
      .msq-thumb img { width: 100%; height: 100%; object-fit: cover; }
      .msq-mode { font-size: 12px; color: #374151; margin: 6px 0; }
      .msq-back-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .msq-kw { flex: 1 1 100%; padding: 8px; border: 1px solid #d1d5db;
        border-radius: 6px; font-size: 13px; }
      .msq-back-btn { flex: 1; background: #2563eb; color: #fff; border: none;
        border-radius: 6px; padding: 8px; font-weight: 700; cursor: pointer; }
      .msq-open-btn { flex: 1; background: #fff; color: #2563eb; border: 1px solid #2563eb;
        border-radius: 6px; padding: 8px; font-weight: 700; cursor: pointer; }
      .msq-body { flex: 1; overflow-y: auto; padding: 8px 14px 24px; }
      .msq-loading { text-align: center; padding: 40px 0 20px; color: #6b7280; }
      .msq-log{margin:16px 10px 0;padding:8px 10px;background:#f3f4f6;border-radius:8px;text-align:left;font-size:11px;line-height:1.5;color:#374151;max-height:240px;overflow-y:auto;font-family:monospace;}
      .msq-log div{padding:1px 0;border-bottom:1px solid #e5e7eb;}
      .msq-spinner { width: 36px; height: 36px; border: 4px solid #bfdbfe;
        border-top-color: #2563eb; border-radius: 50%; margin: 0 auto 12px;
        animation: msq-spin .8s linear infinite; }
      @keyframes msq-spin { to { transform: rotate(360deg); } }
      .msq-no-results { text-align: center; padding: 30px 10px; color: #6b7280; }
      .msq-error-hint { font-size: 12px; color: #9ca3af; margin-top: 6px; }
      .msq-summary { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px;
        background: #f9fafb; border-radius: 8px; margin-bottom: 10px; }
      .msq-stat { flex: 1 1 45%; display: flex; flex-direction: column; }
      .msq-stat-wide { flex-basis: 100%; }
      .msq-stat-label { font-size: 11px; color: #6b7280; }
      .msq-stat-value { font-size: 14px; font-weight: 700; }
      .msq-sold-color { color: #7c3aed; }
      .msq-on-sale { color: #059669; }
      .msq-sold-out { color: #7c3aed; }
      .msq-results-header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      #msq-results-count { font-size: 12px; color: #6b7280; }
      .msq-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .msq-filter-group { display: flex; gap: 4px; }
      .msq-filter-btn { padding: 4px 10px; border: 1px solid #d1d5db; background: #fff;
        border-radius: 6px; font-size: 12px; cursor: pointer; }
      .msq-filter-btn.active { background: #2563eb; color: #fff; border-color: #2563eb; }
      .msq-toggle-btn { padding: 4px 10px; border: 1px solid #d1d5db; background: #fff;
        border-radius: 6px; font-size: 12px; cursor: pointer; }
      .msq-toggle-btn.active { background: #7c3aed; color: #fff; border-color: #7c3aed; }
      .msq-sort-select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; }
      .msq-items { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .msq-item-card { position: relative; border: 1px solid #e5e7eb; border-radius: 8px;
        overflow: hidden; cursor: pointer; transition: opacity .2s, transform .2s; background: #fff; }
      .msq-exclude-btn { position: absolute; top: 4px; right: 4px; z-index: 2;
        width: 20px; height: 20px; border-radius: 10px; border: none;
        background: rgba(0,0,0,.5); color: #fff; cursor: pointer; font-size: 11px; line-height: 1; }
      .msq-item-image { position: relative; width: 100%; aspect-ratio: 1; background: #f3f4f6; }
      .msq-item-image img { width: 100%; height: 100%; object-fit: cover; }
      .msq-no-image { display: flex; align-items: center; justify-content: center;
        height: 100%; color: #9ca3af; font-size: 12px; }
      .msq-status { position: absolute; bottom: 4px; left: 4px; font-size: 10px;
        font-weight: 700; padding: 2px 6px; border-radius: 4px; color: #fff; }
      .msq-status-sold { background: #7c3aed; }
      .msq-status-onsale { background: #059669; }
      .msq-status-unknown { background: #9ca3af; }
      .msq-status-new { position: absolute; top: 4px; left: 4px; font-size: 10px;
        font-weight: 700; padding: 2px 6px; border-radius: 4px; background: #7c3aed; color: #fff; }
      .msq-item-info { padding: 6px; }
      .msq-item-name { font-size: 11px; line-height: 1.3; margin: 0 0 4px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .msq-item-price { font-size: 14px; font-weight: 800; margin: 0; color: #111; }
      .msq-item-likes { font-size: 10px; color: #6b7280; margin: 2px 0 0; }
      .msq-item-condition { font-size: 10px; color: #6b7280; margin: 2px 0 0; }
      .msq-item-condition-new { color: #7c3aed; font-weight: 700; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }
})();
// ===== /PATCH メルカリサーチ Quetta統合ブロック v3 =====