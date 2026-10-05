/* מסמכי הבוט -> n8n -> LlamaParse -> Supabase

   קריאה אחת, והיא מחכה לתוצאה. בשונה מהחשבוניות אין כאן אצווה: קובץ
   אחד, קטן, שנקרא תוך עשרות שניות, ולכן אין צורך בלולאת polling.

   שלושה סוגי כישלון, ולכל אחד הודעה אחרת, כי מה שרמי צריך לעשות שונה:

   1. הקובץ לא נקרא     n8n עצר לפני המחיקה. לא השתנה כלום, והבוט ממשיך
                         לענות מהגרסה הקודמת.
   2. הכתיבה נכשלה      הגרסה הקודמת כבר נמחקה והחדשה לא נשמרה. הבוט
                         יפנה לטלפון בנושא הזה עד שמעלים שוב. זה המקרה
                         היחיד שבו יש מה לעשות עכשיו.
   3. אין תשובה         ניתוק, טלפון שננעל, זמן קצוב. אין דרך לדעת מה
                         קרה, אבל העלאה חוזרת של אותו קובץ בטוחה, כי
                         ההחלפה מוחקת הכל מאותו סוג וכותבת מחדש.

   החוזה המלא מול n8n מתועד ב-knowledge-base/README.md. */
(function () {
  'use strict';

  /* ========================= הגדרות =========================
     כל עוד הוורקפלואו לא פעיל, צריך להחליף כאן webhook ל-webhook-test. */
  var BASE = 'https://shanyptr.app.n8n.cloud/webhook';
  var UPLOAD_URL = BASE + '/kb-upload';
  /* מה טעון כרגע במאגר, לכל סוג מסמך. נקרא ישירות מ-Supabase ולא דרך
     n8n: המידע יושב שם, ו-n8n היה רק מעביר אותו.

     הפונקציה kb_status מחזירה רק סוג, שם קובץ, מתי עלה וכמה קטעים. הטבלה
     documents עצמה סגורה למפתח הזה (RLS בלי שום מדיניות), והמפתח הוא
     המפתח הציבורי של הפרויקט, שנועד בדיוק להיות בקוד של דפדפן.
     החוזה ב-knowledge-base/README.md. */
  var STATUS_URL = 'https://peshvvhgdonacjptdmuq.supabase.co/rest/v1/rpc/kb_status';
  var SUPABASE_KEY = 'sb_publishable_GrL0AWn48k43zwFYIfN7ow_4f1o2U1O';

  /* "לא קיבלנו תשובה" נבדק מול הטבלה: אם הקובץ שנשלח מופיע שם, עם זמן
     העלאה אחרי שליחתו, ההעלאה הצליחה. מרווח של שתי דקות לשעון של
     המחשב, שלא תמיד מסונכרן עם השרת. */
  var CLOCK_SLACK_MS = 2 * 60 * 1000;

  var MAX_FILE_BYTES = 10 * 1024 * 1024;

  /* LlamaParse עם PDF של כמה עמודים חוזר בדרך כלל תוך 10 עד 40 שניות.
     שלוש דקות משאירות מרווח גדול, ועדיין לא משאירות את רמי מול מסך
     תקוע לנצח. */
  var TIMEOUT_MS = 3 * 60 * 1000;

  var ACCEPTED = {
    pdf: 'PDF', docx: 'WORD', doc: 'WORD',
    md: 'MD', markdown: 'MD', txt: 'TXT'
  };

  /* כל הנוסחים שתלויים בסוג המסמך. מין דקדוקי שונה לכל אחד, ולכן
     משפטים שלמים ולא שם עצם שמשבצים בתבנית. הסדר כאן הוא הסדר בטבלה. */
  var TYPES = {
    'price-list': {
      label:    'מחירון',
      replaces: 'המחירון הנוכחי יימחק, והבוט יענה רק מהקובץ שתעלו כאן.',
      action:   'החלפת המחירון',
      done:     'המחירון עודכן',
      topic:    'מחירים ודמי משלוח'
    },
    'delivery-areas': {
      label:    'אזורי משלוח',
      replaces: 'רשימת אזורי המשלוח הנוכחית תימחק, והבוט יענה רק מהקובץ שתעלו כאן.',
      action:   'החלפת אזורי המשלוח',
      done:     'אזורי המשלוח עודכנו',
      topic:    'אזורי משלוח'
    },
    'policies': {
      label:    'מדיניות',
      replaces: 'מסמך המדיניות הנוכחי יימחק, והבוט יענה רק מהקובץ שתעלו כאן.',
      action:   'החלפת המדיניות',
      done:     'המדיניות עודכנה',
      topic:    'הזמנות, ביטולים ושעות'
    }
  };

  /* ========================= עוזרים ========================= */

  function $(id) { return document.getElementById(id); }

  function fmtBytes(n) {
    if (n < 1024) return n + ' בייט';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' קילובייט';
    return (n / 1024 / 1024).toFixed(1) + ' מגה';
  }

  function extOf(name) {
    var m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function say(node, text, kind) {
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.textContent = text;
    node.className = 'form__status' + (kind ? ' form__status--' + kind : '');
    node.hidden = false;
  }

  function show(id) {
    ['pick', 'work', 'result'].forEach(function (s) { $(s).hidden = s !== id; });
    var target = $(id);
    if (target.scrollIntoView) target.scrollIntoView({ block: 'start' });
  }

  /* מספר הגרסה נקרא מתגית הסקריפט של הקובץ הזה עצמו, כמו בעמוד
     החשבוניות, ולכן אם הדפדפן מגיש קוד ישן מהמטמון יוצג המספר הישן. */
  function showVersion() {
    var tag = document.querySelector('script[src*="documents.js"]');
    var src = tag ? tag.getAttribute('src') : '';
    var m = src.match(/[?&]v=([^&]+)/);
    var slot = $('build');
    if (slot) slot.textContent = 'גרסה ' + (m ? m[1] : 'לא ידועה');
  }

  /* ========================= מצב ========================= */

  var state = {
    file: null,
    type: '',
    busy: false,
    wentHidden: false,
    sentAt: 0,
    timer: null
  };

  /* ========================= מה הבוט יודע עכשיו =========================
     שורה לכל סוג מסמך, תמיד שלוש, גם כשאחד חסר. סוג שאין לו מסמך הוא
     מידע בפני עצמו: הבוט מפנה לטלפון בכל שאלה בנושא שלו.

     no-store, כי זו תמונת מצב חיה. תשובה שחוזרת זהה כמה פעמים ברצף היא
     בדיוק מה שדפדפן מתחיל להגיש מהמטמון, ואז הטבלה מראה עולם ישן. */

  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var tz = 'Asia/Jerusalem';
    var date = d.toLocaleDateString('he-IL', { timeZone: tz, day: 'numeric', month: 'numeric', year: 'numeric' });
    var time = d.toLocaleTimeString('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    return 'עלה ב־' + date + ' בשעה ' + time;
  }

  function knownRow(type, doc, fresh) {
    var t = TYPES[type];
    var li = document.createElement('li');
    li.className = 'known__row' + (doc ? '' : ' known__row--missing') + (fresh ? ' known__row--fresh' : '');

    var name = document.createElement('span');
    name.className = 'known__type';
    name.textContent = t.label;
    li.appendChild(name);

    var file = document.createElement('span');
    file.className = 'known__file';
    file.textContent = doc ? (doc.filename || 'קובץ ללא שם') : 'אין מסמך';
    li.appendChild(file);

    var when = document.createElement('span');
    when.className = 'known__when';
    when.textContent = doc
      ? (fresh ? 'עודכן עכשיו' : fmtWhen(doc.loaded_at))
      : 'הבוט מפנה לטלפון בשאלות על ' + t.topic;
    li.appendChild(when);

    return li;
  }

  function knownNote(text) {
    var note = $('known-note');
    note.textContent = text || '';
    note.hidden = !text;
  }

  /* מחזיר מפה מסוג מסמך לשורה שלו, או null אם לא הצלחנו לבדוק.
     null אינו "אין מסמכים", ולכן במקרה הזה הטבלה מתרוקנת ולא מציגה
     שלוש שורות של "אין מסמך" שהיו מבהילות לשווא. */
  function loadKnown(freshType) {
    var list = $('known-list');
    knownNote('בודקים...');

    var ctrl = window.AbortController ? new AbortController() : null;
    var cut = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;

    return fetch(STATUS_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (rows) {
        /* מערך של שורות, אחת לכל סוג שיש לו מסמך. מערך ריק הוא תשובה
           תקינה: המאגר ריק. כל דבר אחר הוא "לא הצלחנו לבדוק". */
        if (!Array.isArray(rows)) throw new Error('shape');
        var map = {};
        rows.forEach(function (d) { if (d && TYPES[d.doc_type]) map[d.doc_type] = d; });

        list.textContent = '';
        Object.keys(TYPES).forEach(function (type) {
          list.appendChild(knownRow(type, map[type], type === freshType && map[type]));
        });
        knownNote('');
        return map;
      })
      .catch(function () {
        list.textContent = '';
        knownNote('לא הצלחנו לבדוק כרגע מה הבוט יודע. אפשר לנסות שוב בעוד רגע.');
        return null;
      })
      .then(function (map) {
        if (cut) clearTimeout(cut);
        return map;
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.busy) state.wentHidden = true;
  });

  /* ========================= בחירה ========================= */

  function refresh() {
    var t = TYPES[state.type];
    var note = $('type-note');
    if (t) { note.textContent = t.replaces; note.hidden = false; }
    else note.hidden = true;

    var btn = $('btn-upload');
    btn.textContent = t ? t.action : 'העלאה';
    btn.disabled = !(t && state.file) || state.busy;
  }

  function takeFile(file) {
    var status = $('pick-status');
    say(status, '');
    if (!file) return;

    var ext = extOf(file.name);
    if (!ACCEPTED[ext]) {
      clearFile();
      say(status, 'הקובץ ' + file.name + ' אינו PDF, Word, Markdown או טקסט, ולכן אי אפשר להעלות אותו.', 'error');
      return;
    }
    if (file.size === 0) {
      clearFile();
      say(status, 'הקובץ ' + file.name + ' ריק.', 'error');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      clearFile();
      say(status, 'הקובץ ' + file.name + ' גדול מ־10 מגה. מסמך של מחירון או מדיניות אמור להיות קטן בהרבה, ואולי נבחר קובץ אחר.', 'error');
      return;
    }

    state.file = file;
    $('chosen-tag').textContent = ACCEPTED[ext];
    $('chosen-name').textContent = file.name;
    $('chosen-size').textContent = fmtBytes(file.size);
    $('chosen').hidden = false;
    refresh();
  }

  function clearFile() {
    state.file = null;
    $('file').value = '';
    $('chosen').hidden = true;
    refresh();
  }

  /* ========================= שליחה ========================= */

  function setStage(name) {
    var order = ['send', 'read'];
    var at = order.indexOf(name);
    Array.prototype.forEach.call(document.querySelectorAll('#stages [data-stage]'), function (li) {
      var i = order.indexOf(li.getAttribute('data-stage'));
      li.className = 'stages__item' +
        (i < at ? ' stages__item--done' : i === at ? ' stages__item--now' : '');
    });
  }

  function startClock() {
    var started = Date.now();
    var slot = $('work-elapsed');
    slot.textContent = '';
    state.timer = setInterval(function () {
      var s = Math.round((Date.now() - started) / 1000);
      slot.textContent = s < 60 ? 'עברו ' + s + ' שניות' : 'עברו ' + Math.floor(s / 60) + ' דקות ו־' + (s % 60) + ' שניות';
    }, 1000);
  }

  function stopClock() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function upload() {
    if (state.busy || !state.file || !TYPES[state.type]) return;
    state.busy = true;
    state.wentHidden = document.hidden;
    state.sentAt = Date.now();
    refresh();

    show('work');
    setStage('send');
    startClock();

    var form = new FormData();
    form.append('file', state.file, state.file.name);
    form.append('doc_type', state.type);
    form.append('filename', state.file.name);

    /* XMLHttpRequest ולא fetch, בשביל upload.onload: זה הרגע האמיתי שבו
       הקובץ הגיע ל-n8n, ומשם השלב השני מתחיל. בלי זה הייתה רק שעה. */
    var xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_URL);
    xhr.timeout = TIMEOUT_MS;
    xhr.upload.onload = function () { setStage('read'); };

    xhr.onload = function () {
      var body = null;
      try { body = JSON.parse(xhr.responseText); } catch (e) { /* לא JSON */ }
      finish(body);
    };
    xhr.onerror = function () { finish(null); };
    xhr.ontimeout = function () { finish(null); };

    xhr.send(form);
  }

  /* ========================= תוצאה ========================= */

  /* תשובה מוכרת מ-n8n הופכת לתוצאה. כל דבר אחר מחזיר null, כלומר
     "לא ידוע", וזה נבדק מול הטבלה לפני שמציגים אותו. */
  function outcome(body) {
    var t = TYPES[state.type];
    if (!body || typeof body.ok !== 'boolean') return null;

    if (body.ok) return success('');

    switch (body.reason) {
      case 'store_failed':
        return {
          kind: 'stop', next: 'retry',
          title: 'צריך להעלות שוב',
          main: 'הגרסה הקודמת כבר נמחקה, והחדשה לא נשמרה. עד שתעלו שוב, הבוט יפנה לקוחות לטלפון בשאלות על ' + t.topic + '.',
          small: 'אם גם ההעלאה החוזרת לא מצליחה, כדאי לפנות לשני.'
        };
      case 'unreadable':
      case 'too_short':
        return {
          kind: 'warn', next: 'pick',
          title: 'המסמך לא עודכן',
          main: body.reason === 'too_short'
            ? 'מהקובץ יצא כמעט רק טקסט ריק. זה קורה בדרך כלל בקובץ סרוק או בצילום של דף. לא שינינו כלום, והבוט ממשיך לענות מהגרסה הקודמת.'
            : 'לא הצלחנו לקרוא את הקובץ, ולכן לא שינינו כלום. הבוט ממשיך לענות מהגרסה הקודמת.',
          small: 'אם יש לכם את המסמך גם ב־Word, נסו להעלות אותו במקום.'
        };
      case 'bad_type':
      case 'too_large':
        return {
          kind: 'warn', next: 'pick',
          title: 'המסמך לא עודכן',
          main: body.reason === 'too_large'
            ? 'הקובץ גדול מדי. לא שינינו כלום, והבוט ממשיך לענות מהגרסה הקודמת.'
            : 'סוג הקובץ לא נתמך. לא שינינו כלום, והבוט ממשיך לענות מהגרסה הקודמת.',
          small: 'אפשר להעלות PDF, Word, Markdown או טקסט, עד 10 מגה.'
        };
      default:
        return null;
    }
  }

  function success(small) {
    return {
      kind: '', next: 'new',
      title: TYPES[state.type].done,
      main: 'מעכשיו הבוט עונה רק מהקובץ ' + state.file.name + '. הגרסה הקודמת נמחקה.',
      small: small || 'כדאי לשאול את הבוט באתר שאלה אחת מהמסמך החדש ולוודא שהתשובה נכונה.'
    };
  }

  function unknown() {
    return {
      kind: 'warn', next: 'retry',
      title: 'לא קיבלנו תשובה',
      main: 'ייתכן שהעדכון הצליח וייתכן שלא, ואין לנו דרך לדעת מכאן. אפשר להעלות את אותו קובץ שוב בלי חשש, והתוצאה תהיה זהה.',
      small: state.wentHidden
        ? 'העמוד היה ברקע בזמן העדכון, וזה יכול לנתק את החיבור. בפעם הבאה כדאי להשאיר אותו פתוח עד הסוף.'
        : 'ייתכן שהחיבור לאינטרנט נותק באמצע.'
    };
  }

  /* הקובץ שנשלח מופיע בטבלה, ועלה אחרי שנשלח: ההעלאה הצליחה גם אם
     התשובה לא הגיעה. שם קובץ לבדו לא מספיק, כי אותו קובץ יכול היה
     לעלות כבר אתמול. */
  function landed(map) {
    var row = map && map[state.type];
    if (!row || row.filename !== state.file.name) return false;
    var at = Date.parse(row.loaded_at);
    return !isNaN(at) && at >= state.sentAt - CLOCK_SLACK_MS;
  }

  function finish(body) {
    stopClock();

    var known = outcome(body);
    if (known) {
      state.busy = false;
      refresh();
      render(known);
      loadKnown(body.ok ? state.type : null);
      return;
    }

    /* עד שהבדיקה חוזרת, הכפתורים נשארים נעולים והעמוד נשאר במסך העבודה */
    $('work-elapsed').textContent = 'בודקים אם העדכון נקלט';
    loadKnown(null).then(function (map) {
      state.busy = false;
      refresh();
      if (landed(map)) {
        loadKnown(state.type);
        render(success('החיבור נותק לפני שהגיעה תשובה, אבל בדקנו: הקובץ נקלט.'));
      } else {
        render(unknown());
      }
    });
  }

  function render(r) {
    var again = $('btn-again');

    $('result-box').className = 'result' + (r.kind ? ' result--' + r.kind : '');
    $('result-title').textContent = r.title;
    $('result-main').textContent = r.main;
    $('result-small').textContent = r.small;

    again.textContent = r.next === 'new' ? 'עדכון מסמך נוסף'
                      : r.next === 'retry' ? 'העלאה שוב של אותו קובץ'
                      : 'בחירת קובץ אחר';
    again.setAttribute('data-next', r.next);

    show('result');
    $('result-title').focus();
  }

  function again() {
    var next = $('btn-again').getAttribute('data-next');
    if (next === 'retry') { upload(); return; }

    if (next === 'new') {
      state.type = '';
      $('doc-type').value = '';
    }
    clearFile();
    say($('pick-status'), '');
    show('pick');
  }

  /* ========================= חיבור ========================= */

  function init() {
    showVersion();

    $('doc-type').addEventListener('change', function (e) {
      state.type = e.target.value;
      refresh();
    });

    $('btn-browse').addEventListener('click', function () { $('file').click(); });
    $('file').addEventListener('change', function (e) { takeFile(e.target.files[0]); });
    $('btn-clear').addEventListener('click', function () { clearFile(); say($('pick-status'), ''); });
    $('btn-upload').addEventListener('click', upload);
    $('btn-again').addEventListener('click', again);
    $('btn-known').addEventListener('click', function () { loadKnown(null); });

    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.add('drop--over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.remove('drop--over');
      });
    });
    drop.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      takeFile(files[0]);
      if (files.length > 1 && state.file) {
        say($('pick-status'), 'מעלים מסמך אחד בכל פעם, ולכן נבחר רק ' + state.file.name + '.', '');
      }
    });

    /* קובץ שנגרר מחוץ לאזור לא נפתח בלשונית במקום העמוד */
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    refresh();
    loadKnown(null);
  }

  init();
})();
