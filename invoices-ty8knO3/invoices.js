/* קליטת חשבוניות -> n8n -> LlamaParse

   התהליך בנוי מארבע קריאות שונות, ובכוונה:

   1. העלאה   קובץ אחד בכל קריאה. הקריאה רק מעלה ומחזירה מיד, היא לא מחכה
              לפירסור. ככה שבע חשבוניות נשלחות תוך שניות, והן מתפרסרות
              במקביל אצל LlamaParse ולא אחת אחרי השנייה.
   2. סקירה   לולאת polling אחת על כל האצווה. LlamaParse לא מכיר אצווה בכלל,
              כל קובץ הוא job נפרד אצלו, ולכן האיחוד לאצווה נעשה ב-n8n.
   3. אישור   חשבונית אחת בכל קריאה, בטור, אחרי שאיריס אישרה או תיקנה.
   4. סיכום   קריאה אחת בסוף, למייל. היא קיימת בדיוק בגלל 3: שם כל הרצה
              מטפלת בחשבונית אחת ולכן אף אחת מהן לא מכירה את האצווה.

   batch_id ו-invoice_id נוצרים כאן בדפדפן, ולכן אפשר להתאים כל תשובה לשורה
   שלה בלי סבב נוסף מול השרת. */
(function () {
  'use strict';

  /* ========================= הגדרות =========================
     ארבעת הוובהוקים של הוורקפלואו "Lehem veshemesh - Invoices".
     כל עוד הוורקפלואו לא פעיל, צריך להחליף כאן webhook ל-webhook-test. */
  var BASE = 'https://shanyptr.app.n8n.cloud/webhook';
  var UPLOAD_URL  = BASE + '/parse-submit';
  var STATUS_URL  = BASE + '/parse-status';
  var CONFIRM_URL = BASE + '/send-invoice-approval';
  /* קריאה רביעית, אחרי שכל האצווה נשמרה. האישור נשלח חשבונית בכל
     קריאה, ולכן אף הרצה שם לא מכירה את שאר האצווה ולא יכולה לסכם
     אותה. הדפדפן הוא היחיד שרואה את התמונה המלאה, והוא שולח אותה. */
  var SUMMARY_URL = BASE + '/batch-done';

  var MAX_FILES = 30;
  var MAX_FILE_BYTES = 25 * 1024 * 1024;

  /* צילום מהטלפון יוצא 4 עד 12 מגה, וזה הרבה על הוויפיי של המטבח,
     ולכן מקטינים. PDF נשלח כמו שהוא.

     היה כאן 2000, וזה התברר כצר מדי לקבלת קופה. קבלה היא רצועה צרה
     וארוכה: בצילום לאורך, הצלע הארוכה היא גובה התמונה, וכשהיא יורדת
     ל-2000 הרוחב יורד לכ-1100 והקבלה עצמה תופסת בתוכו חצי. הספרות
     נשארות עם מעט מדי פיקסלים, ובקבלה אחת אמיתית מספר הפתקית חזר עם
     שתי ספרות מיותרות. 3000 מעלה את הקובץ לכ-800 קילובייט, וזה עדיין
     שליש ממה שהמצלמה מייצרת. */
  var IMAGE_MAX_EDGE = 3000;
  var IMAGE_QUALITY = 0.82;
  var SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;

  var VAT_RATE = 0.18;          /* מע״מ בישראל מינואר 2025 */
  var MONEY_EPSILON = 0.02;     /* סטיית עיגול שעדיין נחשבת מסתדרת */
  var RATE_EPSILON = 0.005;
  var CONFIDENCE_OK = 0.85;     /* מעל זה הכרטיס נפתח מכווץ */

  /* קצב ה-polling. מתחילים צפוף כי רוב החשבוניות חוזרות מהר,
     ומתרווחים אחרי דקה כדי לא להציף את n8n בהמתנה ארוכה. */
  var POLL_FAST_MS = 2000;
  var POLL_SLOW_MS = 5000;
  var POLL_SLOW_AFTER_MS = 40000;
  var POLL_GIVE_UP_MS = 12 * 60 * 1000;
  var POLL_MAX_ERRORS = 4;      /* ניתוקים רצופים לפני שמפסיקים */

  var STATE_LABEL = {
    waiting:    'ממתינה לשליחה',
    uploading:  'נשלחת',
    uploaded:   'הועלתה, ממתינה לקריאה',
    queued:     'בתור',
    parsing:    'נקראת עכשיו',
    validating: 'נבדקת',
    ready:      'נקראה',
    saved:      'נשמרה',
    duplicate:  'כבר בגיליון',
    failed:     'לא נקראה'
  };

  var TERMINAL = { ready: true, failed: true };

  /* בטלפון התמונה ממילא יוצאת גדולה, והצבטה מגדילה אותה טוב יותר מכל
     לוח שנבנה. לכן ההגדלה קיימת רק במכשיר שמצביעים בו בעכבר, שם
     התמונה קטנה ואין מחוות זום. */
  var CAN_DOCK = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  var NET_ERROR = 'אין כרגע תקשורת עם המערכת. אפשר לנסות שוב בעוד רגע.';

  /* ========================= עוזרים ========================= */

  function $(id) { return document.getElementById(id); }

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
      });
    }
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(kid); });
    return node;
  }

  function uid() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) { /* דפדפן ישן */ }
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' בייט';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' קילובייט';
    return (n / 1024 / 1024).toFixed(1) + ' מגה';
  }

  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    return n.toFixed(2).replace(/\.00$/, '') + ' ₪';
  }

  /* מספר מתוך שדה טקסט. מקבל 1,234.56 וגם ‎1234.56 ₪‎ */
  function toNumber(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).replace(/[^\d.,\-]/g, '').replace(/,/g, '');
    if (s === '' || s === '-') return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function say(node, text, kind) {
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.textContent = text;
    node.className = 'form__status' + (kind ? ' form__status--' + kind : '');
    node.hidden = false;
  }

  function plural(n, one, many) { return n === 1 ? one : many.replace('%', n); }

  /* ========================= מצב ========================= */

  var items = [];              /* כל החשבוניות של האצווה הנוכחית */
  var batchId = uid();
  var busy = false;            /* נעול בזמן העלאה וקריאה */
  var phase = 'upload';        /* upload בזמן השליחה, read בזמן הסקירה */

  var els = {
    pick: $('pick'), work: $('work'), review: $('review'), done: $('done'),
    drop: $('drop'),
    fileCamera: $('file-camera'), fileBrowse: $('file-browse'),
    btnCamera: $('btn-camera'), btnBrowse: $('btn-browse'),
    btnUpload: $('btn-upload'), btnClear: $('btn-clear'),
    picked: $('picked'), pickStatus: $('pick-status'),
    workCount: $('work-count'), workBar: $('work-bar'), workFill: $('work-fill'),
    workNote: $('work-note'), worklist: $('worklist'), workStatus: $('work-status'),
    btnRecheck: $('btn-recheck'),
    reviewLede: $('review-lede'), reviewlist: $('reviewlist'),
    reviewStatus: $('review-status'), btnConfirm: $('btn-confirm'),
    doneTitle: $('done-title'), doneLede: $('done-lede'),
    donelist: $('donelist'), btnAgain: $('btn-again')
  };

  function show(step) {
    ['pick', 'work', 'review', 'done'].forEach(function (name) {
      els[name].hidden = (name !== step);
    });
    window.scrollTo(0, 0);
  }

  /* ========================= הגדלת חשבונית =========================
     התמונה בכרטיס קטנה מכדי לקרוא ממנה ספרות, וזו בדיוק העבודה
     שמסך האישור מבקש. שני מצבים: התאמה למסך, וגודל טבעי עם גלילה.

     ההגדלה נפתחת כלוח מעוגן על חצי מסך, ולא כמודאל שמכסה הכול,
     ולכן השדות נשארים גלויים ואפשר להקליד מהתמונה ישירות. מכאן
     נובעות שלוש התנהגויות: אין נעילת גלילה, אין חטיפת מיקוד,
     ולחיצה מחוץ לתמונה לא סוגרת. */

  var lb = $('lightbox');
  var lbImg = $('lb-img');
  var lbDoc = $('lb-doc');
  var lbStage = $('lb-stage');
  var lbZoom = $('lb-zoom');
  var lbClose = $('lb-close');
  var lbFull = false;
  var lbOpener = null;

  function lbSetZoom(full) {
    lbFull = full;
    lbStage.classList.toggle('lightbox__stage--full', full);
    lbZoom.textContent = full ? 'התאמה למסך' : 'גודל מלא';
  }

  function lbOpen(src, alt, opener, isPdf) {
    lbOpener = opener || null;

    if (isPdf) {
      lbImg.hidden = true;
      lbImg.removeAttribute('src');
      lbDoc.src = src;
      lbDoc.hidden = false;
      lbStage.classList.add('lightbox__stage--doc');
      /* ל-PDF אין "גודל מלא": הצופה המובנה של הדפדפן מנהל את הזום בעצמו */
      lbZoom.hidden = true;
    } else {
      lbStage.classList.remove('lightbox__stage--doc');
      lbDoc.hidden = true;
      lbDoc.removeAttribute('src');
      lbImg.hidden = false;
      lbImg.src = src;
      lbImg.alt = alt || '';
      lbZoom.hidden = false;
      lbSetZoom(false);
    }

    lb.hidden = false;
    document.body.classList.add('is-docked');
    /* בכוונה בלי focus כאן. הלוח נפתח כדי שאפשר יהיה להקליד מולו,
       וחטיפת המיקוד לכפתור הסגירה מוציאה את הסמן מהשדה. */
  }

  function lbHide() {
    if (lb.hidden) return;
    /* מחזירים מיקוד רק אם הוא באמת בתוך הלוח. בלי הבדיקה, Escape
       בזמן הקלדה בשדה היה קופץ מהשדה חזרה לכפתור התמונה. */
    var insideLb = lb.contains(document.activeElement);
    lb.hidden = true;
    lbImg.removeAttribute('src');
    lbDoc.removeAttribute('src');
    document.body.classList.remove('is-docked');
    if (lbOpener) {
      if (insideLb) lbOpener.focus();
      lbOpener = null;
    }
  }

  lbClose.addEventListener('click', lbHide);
  lbZoom.addEventListener('click', function () { lbSetZoom(!lbFull); });
  lbImg.addEventListener('click', function () { lbSetZoom(!lbFull); });

  /* אין כאן סגירה בלחיצה מחוץ לתמונה. הלוח צמוד לשדות שעורכים,
     ולחיצה שמחטיאה את קצה התמונה הייתה סוגרת אותו באמצע העבודה.
     סוגרים בכפתור או ב-Escape, שניהם מפורשים. */

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') lbHide();
  });

  /* ========================= שלב 1, בחירה ========================= */

  function addFiles(list) {
    var rejected = [];
    var added = 0;

    Array.prototype.forEach.call(list, function (file) {
      if (items.length >= MAX_FILES) {
        rejected.push(file.name + ' (הרשימה מלאה)');
        return;
      }
      var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      var isImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(file.name);
      if (!isPdf && !isImage) {
        rejected.push(file.name + ' (לא תמונה ולא PDF)');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(file.name + ' (גדול מדי)');
        return;
      }
      /* אותו קובץ נבחר פעמיים, למשל לחיצה כפולה על בחירת קבצים */
      var twice = items.some(function (it) {
        return it.name === file.name && it.size === file.size;
      });
      if (twice) {
        rejected.push(file.name + ' (כבר ברשימה)');
        return;
      }

      items.push({
        id: uid(),
        file: file,
        name: file.name,
        size: file.size,
        isPdf: isPdf,
        /* גם ל-PDF. בלי זה לא היה מקור להציג, והכרטיס הופיע בלי המסמך
           בכלל, כלומר בלי הדבר היחיד שאפשר לאשר מולו. */
        previewUrl: URL.createObjectURL(file),
        state: 'waiting',
        data: null,
        flags: [],
        confidence: null,
        error: null,
        edited: {}
      });
      added++;
    });

    renderPicked();

    if (rejected.length) {
      say(els.pickStatus, 'לא נוספו: ' + rejected.join(', ') + '.', 'error');
    } else if (added) {
      say(els.pickStatus, '');
    }
  }

  function removeItem(id) {
    var i = items.findIndex(function (it) { return it.id === id; });
    if (i === -1) return;
    if (items[i].previewUrl) URL.revokeObjectURL(items[i].previewUrl);
    items.splice(i, 1);
    renderPicked();
  }

  /* ברשימת הנבחרים מציגים תג ולא תצוגה מקדימה של ה-PDF. תמונה ממוזערת
     של PDF דורשת רינדור, וברשימה הזאת מספיק לדעת מה נבחר. */
  function thumbFor(item) {
    if (item.isPdf) {
      return h('span', { class: 'thumb thumb--pdf', text: 'PDF', 'aria-hidden': 'true' });
    }
    return h('img', { class: 'thumb', src: item.previewUrl, alt: '' });
  }

  function renderPicked() {
    els.picked.textContent = '';

    items.forEach(function (item) {
      var drop = h('button', {
        class: 'picked__drop', type: 'button',
        text: 'הסרה',
        'aria-label': 'הסרת ' + item.name
      });
      drop.addEventListener('click', function () { removeItem(item.id); });

      els.picked.appendChild(h('li', { class: 'picked__item' }, [
        thumbFor(item),
        h('div', { class: 'picked__body' }, [
          h('p', { class: 'picked__name', text: item.name }),
          h('p', { class: 'picked__meta', text: fmtBytes(item.size) })
        ]),
        drop
      ]));
    });

    els.btnUpload.disabled = items.length === 0;
    els.btnClear.hidden = items.length === 0;
    els.btnUpload.textContent = items.length
      ? plural(items.length, 'העלאת החשבונית', 'העלאת % החשבוניות')
      : 'העלאה';
  }

  els.btnCamera.addEventListener('click', function () { els.fileCamera.click(); });
  els.btnBrowse.addEventListener('click', function () { els.fileBrowse.click(); });

  [els.fileCamera, els.fileBrowse].forEach(function (input) {
    input.addEventListener('change', function () {
      addFiles(input.files);
      input.value = '';   /* כדי שאפשר יהיה לבחור שוב את אותו קובץ */
    });
  });

  els.btnClear.addEventListener('click', function () {
    items.forEach(function (it) { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
    items = [];
    renderPicked();
    say(els.pickStatus, '');
  });

  ['dragenter', 'dragover'].forEach(function (name) {
    els.drop.addEventListener(name, function (e) {
      e.preventDefault();
      els.drop.classList.add('drop--over');
    });
  });

  ['dragleave', 'drop'].forEach(function (name) {
    els.drop.addEventListener(name, function (e) {
      e.preventDefault();
      els.drop.classList.remove('drop--over');
    });
  });

  els.drop.addEventListener('drop', function (e) {
    if (busy) return;
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  /* גרירה לכל מקום אחר בעמוד לא תפתח את הקובץ בטאב במקום להעלות אותו */
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  /* ========================= הקטנת תמונה ========================= */

  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type)) return resolve({ blob: file, name: file.name });
      if (file.size <= SHRINK_ABOVE_BYTES) return resolve({ blob: file, name: file.name });

      var url = URL.createObjectURL(file);
      var img = new Image();

      /* כל כישלון כאן חוזר לקובץ המקורי. HEIC של אייפון למשל לא תמיד
         נפתח בקנבס, ועדיף לשלוח אותו כמו שהוא מאשר לא לשלוח בכלל. */
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ blob: file, name: file.name }); };

      img.onload = function () {
        var w = img.naturalWidth, hgt = img.naturalHeight;
        var edge = Math.max(w, hgt);
        if (!edge) { URL.revokeObjectURL(url); return resolve({ blob: file, name: file.name }); }

        var scale = Math.min(1, IMAGE_MAX_EDGE / edge);
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(hgt * scale);

        try {
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        } catch (e) {
          URL.revokeObjectURL(url);
          return resolve({ blob: file, name: file.name });
        }

        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob || blob.size >= file.size) return resolve({ blob: file, name: file.name });
          /* הומר ל-JPEG, אז גם הסיומת משתנה כדי שהשם והתוכן יסכימו */
          var name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          resolve({ blob: blob, name: name });
        }, 'image/jpeg', IMAGE_QUALITY);
      };

      img.src = url;
    });
  }

  /* ========================= שלב 2, העלאה וקריאה ========================= */

  function renderWork() {
    els.worklist.textContent = '';

    items.forEach(function (item) {
      var extra = item.state === 'ready' ? ' worklist__item--done'
                : item.state === 'failed' ? ' worklist__item--failed' : '';

      var line = item.state === 'failed' && item.error
        ? STATE_LABEL.failed + ', ' + item.error
        : (STATE_LABEL[item.state] || item.state);

      els.worklist.appendChild(h('li', { class: 'worklist__item' + extra }, [
        thumbFor(item),
        h('div', { class: 'worklist__body' }, [
          h('p', { class: 'worklist__name', text: item.name }),
          h('p', { class: 'worklist__state', text: line })
        ])
      ]));
    });

    var read = items.filter(function (it) { return it.state === 'ready'; }).length;
    var failed = items.filter(function (it) { return it.state === 'failed'; }).length;
    var total = items.length;
    var settled = read + failed;

    els.workCount.textContent = 'נקראו ' + read + ' מתוך ' + total;

    var pct = total ? Math.round((settled / total) * 100) : 0;
    els.workFill.style.width = pct + '%';
    els.workBar.setAttribute('aria-valuenow', String(pct));

    /* השורה מתחת למד נועדה למה שהמונה לא אומר. בשלב השליחה היא אומרת
       איזה קובץ נשלח עכשיו, ובשלב הקריאה היא נסגרת: "נשארו 4 בקריאה"
       זו בדיוק אותה אמירה כמו "נקראו 3 מתוך 7", ולכל שורה ברשימה
       למטה כתוב ממילא מה קורה איתה. */
    if (failed) {
      els.workNote.hidden = false;
      els.workNote.textContent = plural(failed, 'חשבונית אחת לא נקראה.', '% חשבוניות לא נקראו.') +
        ' אפשר יהיה לצלם אותן שוב בסוף.';
    } else if (phase === 'read') {
      els.workNote.hidden = true;
    }
  }

  function uploadOne(item, index) {
    item.state = 'uploading';
    renderWork();

    return shrink(item.file).then(function (out) {
      /* שומרים את הגרסה המוקטנת. היא תישלח שוב בשלב האישור, לדרייב,
         ואין טעם להקטין את אותה תמונה פעמיים. */
      item.sendBlob = out.blob;
      item.sendName = out.name;

      var form = new FormData();
      form.append('file', out.blob, out.name);
      form.append('batch_id', batchId);
      form.append('invoice_id', item.id);
      form.append('fileName', item.name);
      form.append('client_index', String(index + 1));
      form.append('client_total', String(items.length));

      return fetch(UPLOAD_URL, { method: 'POST', body: form });
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text().then(function (body) {
        if (!body) return null;
        try { return JSON.parse(body); } catch (e) { return null; }
      });
    }).then(function (data) {
      /* צומת Respond שמוגדר allIncomingItems מחזיר מערך ולא אובייקט */
      var row = Array.isArray(data) ? data[0] : data;
      if (row && row.ok === false) throw new Error(row.error || 'נדחתה');

      /* jobId הוא כל מה שמחזיק את החשבונית הזאת. בלעדיו אין על מה לסקור,
         ועדיף להיכשל כאן מאשר לסקור לנצח job שלא קיים. */
      item.jobId = row && (row.jobId || row.job_id);
      if (!item.jobId) throw new Error('no-job');

      item.state = 'uploaded';
      renderWork();
    }).catch(function (err) {
      item.state = 'failed';
      item.error = 'ההעלאה נכשלה';
      if (err && err.message === 'no-job') item.error = 'ההעלאה עברה אבל לא חזר מזהה עבודה';
      else if (err && err.message && /HTTP/.test(err.message)) item.error = 'ההעלאה נכשלה, ' + err.message;
      renderWork();
    });
  }

  function uploadAll() {
    var chain = Promise.resolve();
    items.forEach(function (item, i) {
      chain = chain.then(function () {
        els.workNote.textContent = 'שולחים חשבונית ' + (i + 1) + ' מתוך ' + items.length;
        return uploadOne(item, i);
      });
    });
    return chain;
  }

  /* ---------- polling ---------- */

  var pollTimer = null;
  var pollStarted = 0;
  var pollErrors = 0;

  function allSettled() {
    return items.every(function (it) { return TERMINAL[it.state]; });
  }

  /* הוורקפלואו מדבר בשפה של LlamaParse, והעמוד מדבר בשפה של איריס.
     התרגום נעשה כאן, כדי ש-n8n לא יצטרך צומת נוסף רק בשביל זה.
     אם בהמשך יוחזר state מוכן, הוא גובר. */
  function stateFrom(row) {
    if (row.state) return row.state;
    var s = String(row.status || '').toUpperCase();
    if (s === 'COMPLETED') return 'ready';
    if (s === 'FAILED' || s === 'CANCELLED') return 'failed';
    if (s === 'PENDING' || s === 'RUNNING') return 'parsing';
    return row.done === true ? 'ready' : 'parsing';
  }

  function matchItem(row) {
    var id = row.invoice_id;
    if (id) return items.find(function (it) { return it.id === id; });
    var job = row.jobId || row.job_id;
    if (job) return items.find(function (it) { return it.jobId === job; });
    return null;
  }

  function applyStatus(list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (row) {
      if (!row) return;
      var item = matchItem(row);
      if (!item) return;
      /* חשבונית שנכשלה כבר בהעלאה לא חוזרת לחיים מתשובת סטטוס */
      if (item.state === 'failed') return;

      item.state = stateFrom(row);
      if (row.data) item.data = row.data;
      if (typeof row.confidence === 'number') item.confidence = row.confidence;
      if (Array.isArray(row.flags)) item.flags = row.flags;
      if (row.message || row.error) item.error = row.message || row.error;
      if (row.file_url) item.fileUrl = row.file_url;
    });
  }

  function pollOnce() {
    /* שואלים רק על מה שעדיין פתוח. ככה הבקשה מתכווצת ככל שהאצווה מתקדמת. */
    var open = items.filter(function (it) { return it.jobId && !TERMINAL[it.state]; });
    if (!open.length) return Promise.resolve(true);

    return fetch(STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch_id: batchId,
        jobs: open.map(function (it) {
          return { invoice_id: it.id, jobId: it.jobId };
        })
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      pollErrors = 0;
      say(els.workStatus, '');
      if (!data || data.ok === false) throw new Error('bad payload');

      /* מקבל גם מערך שטוח מ-allIncomingItems וגם {invoices:[...]} */
      applyStatus(Array.isArray(data) ? data : data.invoices);
      renderWork();

      return (!Array.isArray(data) && data.done === true) || allSettled();
    });
  }

  function scheduleNextPoll() {
    var waited = Date.now() - pollStarted;

    if (waited > POLL_GIVE_UP_MS) {
      say(els.workStatus,
        'הקריאה לוקחת יותר מהרגיל. אפשר לבדוק שוב, והחשבוניות שכבר נקראו לא ילכו לאיבוד.',
        'error');
      els.btnRecheck.hidden = false;
      unlock();
      return;
    }

    var gap = waited > POLL_SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
    pollTimer = setTimeout(runPoll, gap);
  }

  function runPoll() {
    pollOnce().then(function (finished) {
      if (finished) { finishWork(); return; }
      scheduleNextPoll();
    }).catch(function () {
      pollErrors++;
      if (pollErrors >= POLL_MAX_ERRORS) {
        say(els.workStatus, NET_ERROR, 'error');
        els.btnRecheck.hidden = false;
        unlock();
        return;
      }
      say(els.workStatus, 'התקשורת נקטעה, מנסים שוב.');
      scheduleNextPoll();
    });
  }

  function startPolling() {
    pollStarted = Date.now();
    pollErrors = 0;
    phase = 'read';
    els.btnRecheck.hidden = true;
    renderWork();
    runPoll();
  }

  els.btnRecheck.addEventListener('click', function () {
    lock();
    els.btnRecheck.hidden = true;
    say(els.workStatus, '');
    startPolling();
  });

  function finishWork() {
    if (pollTimer) clearTimeout(pollTimer);
    unlock();
    buildReview();
    show('review');
  }

  /* ---------- נעילה ---------- */

  function lock() {
    busy = true;
    els.btnUpload.disabled = true;
    els.btnCamera.disabled = true;
    els.btnBrowse.disabled = true;
    els.btnClear.disabled = true;
  }

  function unlock() {
    busy = false;
    els.btnCamera.disabled = false;
    els.btnBrowse.disabled = false;
    els.btnClear.disabled = false;
    els.btnUpload.disabled = items.length === 0;
  }

  /* סגירת הטאב באמצע הקריאה מאבדת את מסך האישור, והחשבוניות יישארו
     בגיליון במצב ממתין. שווה אזהרה. */
  window.addEventListener('beforeunload', function (e) {
    if (!busy) return;
    e.preventDefault();
    e.returnValue = '';
  });

  els.btnUpload.addEventListener('click', function () {
    if (busy || !items.length) return;
    lock();
    phase = 'upload';
    els.workNote.hidden = false;
    say(els.pickStatus, '');
    say(els.workStatus, '');
    renderWork();
    show('work');

    uploadAll().then(function () {
      var live = items.filter(function (it) { return it.state !== 'failed'; });
      if (!live.length) {
        say(els.workStatus, 'אף חשבונית לא הועלתה. כדאי לבדוק את החיבור ולנסות שוב.', 'error');
        unlock();
        els.btnRecheck.hidden = true;
        show('pick');
        return;
      }
      startPolling();
    });
  });

  /* ========================= שלב 3, אישור ========================= */

  /* מה שבודקים בצד הזה הוא רק שהמספרים שמוצגים מסכימים בינם לבין עצמם.
     זו לא בדיקה שהקריאה נכונה, ולכן הטקסט אומר במפורש כשאין מול מה להצליב. */
  function mathLine(subtotal, vat, total) {
    if (total === null) {
      return { kind: '', text: 'אין סה״כ. צריך למלא אותו מהחשבונית.' };
    }
    if (subtotal === null || vat === null) {
      return {
        kind: '',
        text: 'יש רק סה״כ, ואין מול מה להצליב אותו. כדאי להשוות לחשבונית עצמה.'
      };
    }

    var sum = subtotal + vat;
    var sumOk = Math.abs(sum - total) <= MONEY_EPSILON;
    var rate = subtotal > 0 ? vat / subtotal : null;
    var rateOk = rate !== null && Math.abs(rate - VAT_RATE) <= RATE_EPSILON;

    if (!sumOk) {
      return {
        kind: 'off',
        text: 'הסכומים לא מסתדרים. ' + subtotal.toFixed(2) + ' ועוד ' + vat.toFixed(2) +
              ' יוצא ' + sum.toFixed(2) + ', ובשדה סה״כ כתוב ' + total.toFixed(2) + '.'
      };
    }
    if (!rateOk) {
      var pct = rate === null ? '—' : (rate * 100).toFixed(1);
      return {
        kind: 'off',
        text: 'החיבור מסתדר, אבל המע״מ יוצא ' + pct + ' אחוז ולא 18. ' +
              'יכול להיות חשבונית ישנה, ויכול להיות ספרה שנקראה לא נכון.'
      };
    }
    return {
      kind: 'ok',
      text: 'הסכומים מסתדרים. ' + subtotal.toFixed(2) + ' ועוד מע״מ ' + vat.toFixed(2) +
            ' יוצא ' + total.toFixed(2) + '.'
    };
  }

  function needsEye(item) {
    if (item.state === 'failed') return true;
    if (item.confirmError) return true;
    if (item.flags && item.flags.length) return true;
    if (typeof item.confidence === 'number' && item.confidence < CONFIDENCE_OK) return true;
    return false;
  }

  /* השדות נשמרים על הפריט עצמו ולא נשלפים מה-DOM לפי id. הכרטיס נבנה
     לפני שהוא מחובר למסמך, ולכן getElementById היה מחזיר כאן null. */
  function field(item, key, label, opts) {
    var input = h('input', {
      type: (opts && opts.type) || 'text',
      id: 'f-' + item.id + '-' + key,
      value: (item.data && item.data[key] !== null && item.data[key] !== undefined)
        ? String(item.data[key]) : '',
      inputmode: (opts && opts.inputmode) || null,
      autocomplete: 'off'
    });

    item.inputs[key] = input;

    input.addEventListener('input', function () {
      item.edited[key] = true;
      input.classList.add('is-edited');
      if (opts && opts.recheck) opts.recheck();
    });

    return h('div', { class: 'rev__field' }, [
      h('label', { for: input.id, text: label }),
      input
    ]);
  }

  function reviewCard(item) {
    var eye = needsEye(item);
    item.inputs = {};
    var card = h('li', {
      class: 'rev ' + (item.state === 'failed' ? 'rev--failed'
                     : item.state === 'skipped' ? 'rev--skipped'
                     : (item.state === 'saved' || !eye) ? 'rev--ok' : 'rev--check')
    });

    /* חשבונית שכבר נשמרה מוצגת לפי מה שאיריס אישרה, לא לפי מה שנקרא */
    var d = (item.state === 'saved' ? item.savedRow : item.data) || {};
    var totalText = d.total !== null && d.total !== undefined ? fmtMoney(Number(d.total)) : '—';

    var badgeClass = item.state === 'failed' ? 'failed'
                   : item.state === 'skipped' ? 'skip'
                   : (item.state === 'saved' || !eye) ? 'ok' : 'check';
    var badgeText = item.state === 'failed' ? 'לא נקראה'
                  : item.state === 'saved' ? 'נשמרה'
                  : item.state === 'skipped' ? 'לא תישמר'
                  : eye ? 'דורש עין' : 'נבדק';

    var head = h('div', { class: 'rev__head' }, [
      h('span', { class: 'rev__badge rev__badge--' + badgeClass, text: badgeText }),
      h('div', { class: 'rev__ident' }, [
        h('p', { class: 'rev__supplier', text: d.supplier || item.name }),
        h('p', {
          class: 'rev__sub',
          text: [d.date || '', d.invoice_number ? 'חשבונית ' + d.invoice_number : '']
            .filter(Boolean).join('  ·  ') || item.name
        })
      ]),
      item.state === 'failed' ? null : h('p', { class: 'rev__total', text: totalText })
    ]);

    card.appendChild(head);

    /* נשמרה כבר. לא ניתנת לעריכה, כדי שלחיצה חוזרת על האישור לא תיצור
       שורה כפולה בגיליון. */
    if (item.state === 'saved') return card;

    /* הוצאה מהשמירה. קובץ שאינו חשבונית חוזר ריק, ובלי דרך להוציא
       אותו הוא מחזיק את כל האצווה כבן ערובה: הבדיקה דורשת סה״כ, והוא
       לא יקבל סה״כ לעולם. זו פעולה הפיכה, ולכן כפתור ולא מחיקה. */
    if (item.state === 'skipped') {
      card.appendChild(h('p', {
        class: 'rev__failed',
        text: 'הוצאה מהשמירה ולא תיכנס לגיליון.'
      }));
      var back = h('button', {
        class: 'rev__toggle', type: 'button', text: 'להחזיר לשמירה'
      });
      back.addEventListener('click', function () {
        item.state = 'ready';
        buildReview();
      });
      card.appendChild(back);
      return card;
    }

    if (item.state === 'failed') {
      card.appendChild(h('p', {
        class: 'rev__failed',
        text: (item.error || 'החשבונית לא נקראה') +
              '. היא לא תישמר בגיליון, ואפשר לצלם אותה שוב אחרי השמירה.'
      }));
      return card;
    }

    /* ---- הגוף הפתוח ---- */
    var open = h('div', { class: 'rev__open' });
    open.hidden = !eye;

    /* סיבת דחייה מהוורקפלואו, למשל כפילות. היא עולה מעל הדגלים,
       כי היא הסיבה שהשורה הזאת עדיין כאן. */
    if (item.confirmError) {
      open.appendChild(h('p', { class: 'rev__reject', text: item.confirmError }));
    }

    if (item.flags && item.flags.length) {
      open.appendChild(h('ul', { class: 'rev__flags' },
        item.flags.map(function (flag) {
          var text = typeof flag === 'string' ? flag : (flag.message || flag.code || '');
          return text ? h('li', { class: 'rev__flag', text: text }) : null;
        })
      ));
    }

    var math = h('p', { class: 'rev__math' });

    function recheck() {
      var line = mathLine(
        toNumber(item.inputs.subtotal.value),
        toNumber(item.inputs.vat.value),
        toNumber(item.inputs.total.value)
      );
      math.className = 'rev__math' + (line.kind ? ' rev__math--' + line.kind : '');
      math.textContent = line.text;
    }

    var fields = h('div', { class: 'rev__fields' }, [
      field(item, 'supplier', 'ספק'),
      h('div', { class: 'rev__pair' }, [
        field(item, 'invoice_number', 'מספר חשבונית'),
        field(item, 'date', 'תאריך', { type: 'date' })
      ]),
      h('div', { class: 'rev__pair' }, [
        field(item, 'subtotal', 'לפני מע״מ', { inputmode: 'decimal', recheck: recheck }),
        field(item, 'vat', 'מע״מ', { inputmode: 'decimal', recheck: recheck }),
        field(item, 'total', 'סה״כ לתשלום', { inputmode: 'decimal', recheck: recheck }),
        math
      ])
    ]);

    /* התמונה מהמכשיר, לא מהשרת. זה גם הקובץ המקורי במלוא הרזולוציה,
       ולכן ההגדלה באמת מראה את הספרות ולא גרסה מוקטנת. */
    var shot = null;
    var src = item.previewUrl || item.fileUrl;
    if (src) {
      var alt = 'החשבונית, ' + (d.supplier || item.name);

      if (item.isPdf) {
        /* PDF לא יכול לשבת בתוך button: הוא בולע את הלחיצה, וכפתור
           לא אמור להכיל תוכן אינטראקטיבי. לכן המסמך מוצג ישירות,
           והפעולות יושבות לצידו. הקישור לכרטיסייה חדשה הוא לא נוחות
           אלא רשת ביטחון, כי ספארי בנייד לא תמיד מרנדר PDF ב-iframe. */
        var doc = h('iframe', { class: 'rev__pdf', src: src, title: alt });

        var big = null;
        if (CAN_DOCK) {
          big = h('button', { class: 'rev__docbtn', type: 'button', text: 'הגדלה' });
          big.addEventListener('click', function () { lbOpen(src, alt, big, true); });
        }

        shot = h('figure', { class: 'rev__shot rev__shot--doc' }, [
          doc,
          h('div', { class: 'rev__docbar' }, [
            big,
            h('a', {
              class: 'rev__docbtn', href: src, target: '_blank', rel: 'noopener',
              text: 'פתיחה בכרטיסייה חדשה'
            })
          ])
        ]);
      } else if (CAN_DOCK) {
        var zoom = h('button', {
          class: 'rev__zoom', type: 'button', 'aria-label': 'הגדלת ' + alt
        }, [h('img', { src: src, alt: alt, loading: 'lazy' })]);

        zoom.addEventListener('click', function () { lbOpen(src, alt, zoom, false); });

        shot = h('figure', { class: 'rev__shot' }, [
          zoom,
          h('figcaption', { text: 'לחיצה על התמונה מגדילה אותה' })
        ]);
      } else {
        /* בלי כפתור ובלי כיתוב. התמונה היא תמונה, ומצביטים עליה. */
        shot = h('figure', { class: 'rev__shot' }, [
          h('img', { src: src, alt: alt, loading: 'lazy' })
        ]);
      }
    }

    /* PDF מקבל עמודה רחבה יותר מתמונה. הצופה המובנה של הדפדפן הוא
       יישום עם סרגל כלים משלו, ובעמודה צרה הוא נחנק. */
    open.appendChild(h('div', {
      class: 'rev__grid' + (item.isPdf ? ' rev__grid--doc' : '')
    }, [shot, fields]));
    card.appendChild(open);

    var toggle = h('button', {
      class: 'rev__toggle', type: 'button',
      text: eye ? 'סגירה' : 'פתיחה לעריכה',
      'aria-expanded': eye ? 'true' : 'false'
    });
    toggle.addEventListener('click', function () {
      open.hidden = !open.hidden;
      toggle.textContent = open.hidden ? 'פתיחה לעריכה' : 'סגירה';
      toggle.setAttribute('aria-expanded', open.hidden ? 'false' : 'true');
    });
    head.appendChild(toggle);

    var skip = h('button', {
      class: 'rev__toggle rev__toggle--skip', type: 'button', text: 'לא לשמור את זו'
    });
    skip.addEventListener('click', function () {
      item.state = 'skipped';
      buildReview();
    });
    head.appendChild(skip);

    recheck();
    return card;
  }

  function buildReview() {
    els.reviewlist.textContent = '';

    /* מה שדורש עין עולה למעלה, כדי שהעבודה תהיה בתחילת המסך ולא בסופו.
       חשבונית שנכשלה יורדת לתחתית, כי אין עליה מה לעשות עכשיו. */
    function rank(item) {
      if (item.state === 'failed') return 4;
      if (item.state === 'skipped') return 3;
      if (item.state === 'saved') return 2;
      return needsEye(item) ? 0 : 1;
    }
    var ordered = items.slice().sort(function (a, b) { return rank(a) - rank(b); });

    ordered.forEach(function (item) {
      els.reviewlist.appendChild(reviewCard(item));
    });

    var ready = items.filter(function (it) { return it.state === 'ready'; });
    var saved = items.filter(function (it) { return it.state === 'saved'; }).length;
    var eyes = ready.filter(needsEye).length;
    var failed = items.filter(function (it) { return it.state === 'failed'; }).length;

    var parts = [];
    if (saved) {
      /* חוזרים למסך הזה רק אחרי שמירה חלקית */
      parts.push(plural(saved, 'חשבונית אחת כבר נשמרה.', '% חשבוניות כבר נשמרו.'));
      parts.push(plural(ready.length, 'נשארה אחת לשמירה.', 'נשארו % לשמירה.'));
    } else {
      parts.push(plural(ready.length, 'חשבונית אחת נקראה.', '% חשבוניות נקראו.'));
    }
    if (eyes) {
      parts.push(plural(eyes,
        'אחת מסומנת ודורשת עין, והיא פתוחה למעלה.',
        '% מהן מסומנות ודורשות עין, והן פתוחות למעלה.'));
    }
    if (!saved) parts.push('שום סכום לא נכנס לגיליון לפני שלוחצים על האישור.');
    if (failed) {
      parts.push(plural(failed,
        'חשבונית אחת לא נקראה ולא תישמר.',
        '% חשבוניות לא נקראו ולא יישמרו.'));
    }
    var skipped = items.filter(function (it) { return it.state === 'skipped'; }).length;
    if (skipped) {
      parts.push(plural(skipped,
        'אחת הוצאה מהשמירה.',
        '% הוצאו מהשמירה.'));
    }

    els.reviewLede.textContent = parts.join(' ');
    els.btnConfirm.disabled = ready.length === 0;
    els.btnConfirm.textContent = ready.length === 1
      ? 'אישור ושמירה בגיליון'
      : 'אישור ושמירת ' + ready.length + ' החשבוניות';
  }

  /* ---------- שליחת האישור ---------- */

  function collect(item) {
    function val(key) {
      var node = item.inputs && item.inputs[key];
      return node ? node.value.trim() : '';
    }
    return {
      invoice_id: item.id,
      supplier: val('supplier'),
      invoice_number: val('invoice_number'),
      date: val('date'),
      subtotal: toNumber(val('subtotal')),
      vat: toNumber(val('vat')),
      total: toNumber(val('total')),
      /* הח.פ. נוסע איתנו אבל אין לו שדה במסך. הוא נקרא בהרצת הקריאה,
         והכתיבה לגיליון קורית בהרצת האישור, ולכן הדפדפן הוא המוביל
         היחיד בין השתיים. איריס לא מאמתת אותו, ולכן הוא לא מעורבב
         עם הערכים שכן עברו את עינה ולא נכנס ל-edited. */
      supplier_tax_id: (item.data && item.data.supplier_tax_id) || '',
      edited: Object.keys(item.edited)
    };
  }

  /* האישור נשלח חשבונית אחת בכל קריאה, ועם הקובץ.

     הסיבה: את הקובץ מחזיק רק הדפדפן. ב-parse-status יש ל-n8n רק jobId,
     והבינארי אף פעם לא היה בהרצה ההיא. את התאריך, לעומת זאת, אפשר לדעת
     רק אחרי הקריאה, ואת התאריך הנכון רק אחרי שאיריס אישרה אותו.
     הרגע היחיד שבו גם הקובץ וגם התאריך המאושר קיימים הוא כאן. */
  function confirmOne(item, row, index, total) {
    var form = new FormData();

    if (item.sendBlob) form.append('file', item.sendBlob, item.sendName);
    form.append('batch_id', batchId);
    form.append('invoice_id', item.id);
    form.append('supplier', row.supplier);
    form.append('invoice_number', row.invoice_number);
    form.append('date', row.date);
    form.append('subtotal', row.subtotal === null ? '' : String(row.subtotal));
    form.append('vat', row.vat === null ? '' : String(row.vat));
    form.append('total', row.total === null ? '' : String(row.total));
    form.append('supplier_tax_id', row.supplier_tax_id || '');
    form.append('edited', row.edited.join(','));
    form.append('client_index', String(index + 1));
    form.append('client_total', String(total));

    return fetch(CONFIRM_URL, { method: 'POST', body: form }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var out = Array.isArray(data) ? data[0] : data;

      /* כפילות היא תשובה סופית ולא תקלה. ניסיון חוזר ייענה בדיוק אותו
         דבר, ולכן היא מקבלת מצב משלה: היא יוצאת מרשימת המועמדות
         לשליחה, לא חוסמת את המעבר למסך הסיום, ומדווחת במייל בנפרד.
         בלי ההבחנה הזאת אצווה עם כפילות אחת הייתה נתקעת במסך האישור
         בלולאה שאי אפשר לצאת ממנה. */
      if (out && out.code === 'duplicate') {
        item.state = 'duplicate';
        item.savedRow = row;
        item.confirmError = out.error || 'החשבונית כבר נמצאת בגיליון.';
        return;
      }

      if (!out || out.ok !== true) {
        /* דחייה מנומקת אחרת. ההסבר של הוורקפלואו נשמר ומוצג על
           הכרטיס, כי הוא נכתב בשביל איריס ולא בשביל הלוג. */
        var rejected = new Error('rejected');
        rejected.info = out && out.error;
        throw rejected;
      }
      /* מסומנת כנשמרה, ולכן לחיצה חוזרת לא תשלח אותה שוב */
      item.state = 'saved';
      item.savedRow = row;
      item.confirmError = null;
    });
  }

  els.btnConfirm.addEventListener('click', function () {
    var ready = items.filter(function (it) { return it.state === 'ready'; });
    if (!ready.length) return;

    var rows = ready.map(collect);

    var missing = rows.filter(function (row) { return row.total === null; });
    if (missing.length) {
      say(els.reviewStatus,
        plural(missing.length,
          'חשבונית אחת בלי סה״כ. צריך למלא אותו לפני השמירה.',
          '% חשבוניות בלי סה״כ. צריך למלא אותו לפני השמירה.'),
        'error');
      return;
    }

    els.btnConfirm.disabled = true;
    busy = true;

    var failedNow = 0;
    var chain = Promise.resolve();

    ready.forEach(function (item, i) {
      chain = chain.then(function () {
        say(els.reviewStatus, 'שומרים חשבונית ' + (i + 1) + ' מתוך ' + ready.length + '…');
        return confirmOne(item, rows[i], i, ready.length).catch(function (err) {
          item.confirmError = (err && err.info) ||
            'השמירה לא עברה. אפשר לנסות שוב.';
          failedNow++;
        });
      });
    });

    chain.then(function () {
      busy = false;
      var saved = items.filter(function (it) { return it.state === 'saved'; });
      var dups = items.filter(function (it) { return it.state === 'duplicate'; });

      /* אצווה שכולה כפילויות סגורה, לא כושלת. אין מה לנסות שוב. */
      if (!saved.length && dups.length && !failedNow) {
        say(els.reviewStatus, '');
        sendSummary(saved, dups);
        buildDone();
        show('done');
        return;
      }

      if (!saved.length) {
        els.btnConfirm.disabled = false;
        say(els.reviewStatus,
          'השמירה לא הצליחה. שום דבר לא נשמר, והפרטים כאן נשארו. אפשר לנסות שוב.',
          'error');
        return;
      }

      /* שמירה חלקית. נשארים כאן, מה שנשמר ננעל, ולחיצה נוספת תשלח
         רק את מה שעדיין לא נשמר. */
      if (failedNow) {
        buildReview();
        say(els.reviewStatus,
          plural(failedNow,
            'חשבונית אחת לא נשמרה. מה שנשמר כבר לא יישלח שוב, אפשר ללחוץ שוב על השאר.',
            '% חשבוניות לא נשמרו. מה שנשמר כבר לא יישלח שוב, אפשר ללחוץ שוב על השאר.'),
          'error');
        return;
      }

      say(els.reviewStatus, '');
      sendSummary(saved, dups);
      buildDone();
      show('done');
    });
  });

  /* הסיכום נשלח אחרי שהכול נשמר, ובכוונה בלי await ובלי חסימה:
     ההודעה שהחשבוניות נשמרו כבר נכונה, ומייל שלא יצא הוא לא סיבה
     להחזיק את איריס במסך. כישלון כאן נרשם בקונסול ונגמר. */
  function sendSummary(saved, dups) {
    dups = dups || [];
    if (!saved.length && !dups.length) return;

    function line(item) {
      var row = item.savedRow || {};
      return {
        supplier: row.supplier || '',
        invoice_number: row.invoice_number || '',
        date: row.date || '',
        total: row.total === null || row.total === undefined ? '' : String(row.total)
      };
    }

    var payload = {
      batch_id: batchId,
      saved_count: saved.length,
      invoices: saved.map(line),
      duplicates: dups.map(line)
    };

    fetch(SUMMARY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function () { /* המייל הוא תוצר לוואי, לא חלק מהשמירה */ });
  }

  /* ========================= שלב 4, סיום ========================= */

  function buildDone() {
    els.donelist.textContent = '';

    var rows = items
      .filter(function (it) { return it.state === 'saved'; })
      .map(function (it) { return it.savedRow; });

    var dupItems = items.filter(function (it) { return it.state === 'duplicate'; });

    function line(row, isDup) {
      return h('li', { class: 'donelist__item' + (isDup ? ' donelist__item--dup' : '') }, [
        h('div', {}, [
          h('p', { class: 'donelist__who', text: row.supplier || 'ללא שם ספק' }),
          h('p', {
            class: 'donelist__what',
            text: [row.date, row.invoice_number ? 'חשבונית ' + row.invoice_number : '',
              isDup ? 'כבר בגיליון, לא נשמרה שוב' : '']
              .filter(Boolean).join('  ·  ')
          })
        ]),
        h('p', { class: 'donelist__sum', text: fmtMoney(row.total) })
      ]);
    }

    rows.forEach(function (row) { els.donelist.appendChild(line(row, false)); });
    dupItems.forEach(function (it) {
      els.donelist.appendChild(line(it.savedRow || {}, true));
    });

    var sum = rows.reduce(function (acc, row) { return acc + (row.total || 0); }, 0);
    var failed = items.filter(function (it) { return it.state === 'failed'; }).length;
    var dups = dupItems.length;

    /* כותרת המסך נקבעת כאן ולא ב-HTML. "נשמר" מעל מסך שבו לא נשמר
       כלום הוא פשוט לא נכון, וזה המצב כשכל האצווה כבר הייתה בגיליון. */
    var nothingNew = rows.length === 0 && dups > 0;
    els.doneTitle.textContent = nothingNew ? 'לא נשמר כלום' : 'נשמר';

    var text;
    if (nothingNew) {
      text = 'המערכת קראה את החשבוניות ועבדה כרגיל, אבל לא נוספה שורה חדשה לגיליון. ' +
        plural(dups, 'החשבונית כבר הייתה שם.', 'כל % החשבוניות כבר היו שם.');
    } else {
      text = plural(rows.length, 'חשבונית אחת נשמרה', '% חשבוניות נשמרו') +
        ' בגיליון ובדרייב, בסך הכל ' + fmtMoney(sum) + '.';
      /* כפילות היא לא כישלון ולא הצלחה, ולכן היא נאמרת בנפרד. בלי זה
         איריס רואה "נשמרו 2" אחרי שהעלתה 3, בלי לדעת מה קרה לשלישית. */
      if (dups) {
        text += ' ' + plural(dups,
          'חשבונית אחת לא נשמרה כי היא כבר בגיליון.',
          '% חשבוניות לא נשמרו כי הן כבר בגיליון.');
      }
    }

    if (failed) {
      text += ' ' + plural(failed,
        'חשבונית אחת לא נקראה וכדאי לצלם אותה שוב.',
        '% חשבוניות לא נקראו וכדאי לצלם אותן שוב.');
    }
    els.doneLede.textContent = text;
  }

  els.btnAgain.addEventListener('click', function () {
    items.forEach(function (it) { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
    items = [];
    batchId = uid();
    phase = 'upload';
    els.workNote.hidden = false;
    renderPicked();
    say(els.pickStatus, '');
    say(els.workStatus, '');
    say(els.reviewStatus, '');
    els.btnRecheck.hidden = true;
    unlock();
    show('pick');
  });

  /* ========================= התחלה ========================= */
  renderPicked();
  show('pick');
})();
