/* חלון השאלות -> וובהוק n8n -> הבוט
   הבוט עונה רק מתוך המסמכים שרמי ואיריס העלו: אזור החלוקה, המחירון
   והמדיניות. הוא לא מקבל הזמנות. החוזה המלא ב-knowledge-base/README.md.

   המצב יושב בדפדפן, כמו בשאר האתר: מזהה השיחה והשיחה עצמה נשמרים
   ב-sessionStorage, ולכן רענון לא מוחק אותה, וזיכרון הבוט ב-n8n נשאר
   מסונכרן איתה. טאב חדש הוא שיחה חדשה. */
(function () {
  'use strict';

  var WEBHOOK = 'https://shanyptr.app.n8n.cloud/webhook/kb-bot';
  var MAX_CHARS = 500;        /* זהה לתקרה בנוד Guard */
  var TIMEOUT_MS = 45000;     /* חיפוש ומודל לוקחים 5 עד 15 שניות. מעבר לזה משהו נתקע */
  var KEEP = 30;              /* כמה הודעות נשמרות לרענון */
  var STORE_KEY = 'lvs-chat';

  var GREETING = 'שלום! אפשר לשאול כאן לאילו רחובות אנחנו מגיעים, כמה עולה משלוח ועד מתי מזמינים. את ההזמנה עצמה שולחים בטופס שבאתר.';
  var PENDING = 'בודקים…';
  var ERRORS = {
    rate_limited: 'נשלחו הרבה שאלות בזמן קצר. אפשר לנסות שוב בעוד כמה דקות, או להתקשר למאפייה 04-1234567.',
    too_long: 'השאלה ארוכה מדי. אפשר לקצר אותה ולשלוח שוב.',
    generic: 'לא הצלחנו לקבל תשובה כרגע. אפשר לנסות שוב, או להתקשר למאפייה 04-1234567.'
  };

  var root = document.getElementById('chat');
  if (!root) return;
  var openBtn = document.getElementById('chat-open');
  var closeBtn = document.getElementById('chat-close');
  var panel = document.getElementById('chat-panel');
  var log = document.getElementById('chat-log');
  var suggest = document.getElementById('chat-suggest');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var send = document.getElementById('chat-send');

  var state = load();
  var sending = false;

  /* ---------- שמירה ---------- */

  function newId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var hex = '';
    for (var i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
    return hex;
  }

  /* נכשל בשקט בגלישה פרטית, ואז השיחה פשוט לא שורדת רענון */
  function load() {
    try {
      var saved = JSON.parse(window.sessionStorage.getItem(STORE_KEY) || 'null');
      if (saved && typeof saved.sessionId === 'string' && Array.isArray(saved.messages)) return saved;
    } catch (e) { /* ממשיכים לשיחה חדשה */ }
    return { sessionId: newId(), messages: [] };
  }

  function save() {
    state.messages = state.messages.slice(-KEEP);
    try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* כנ"ל */ }
  }

  /* ---------- תצוגה ---------- */

  /* התשובה נכנסת כטקסט ולעולם לא כ-HTML, כך שתשובה של מודל לא יכולה
     להזריק קוד לעמוד. שני תיקונים בלבד: מספר הטלפון הופך לקישור חיוג,
     כי תשובת "אינני יודע" מסתיימת בו ובנייד זו הפעולה היחידה שמועילה,
     וסימון markdown שהמודל השאיר למרות ההנחיה יורד. */
  var PHONE = /0\d-?\d{7}/g;

  function clean(text) {
    return String(text)
      .replace(/\*\*|__/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .trim();
  }

  function fill(el, text) {
    var last = 0;
    var match;
    PHONE.lastIndex = 0;
    while ((match = PHONE.exec(text))) {
      if (match.index > last) el.appendChild(document.createTextNode(text.slice(last, match.index)));
      var a = document.createElement('a');
      a.href = 'tel:' + match[0].replace(/-/g, '');
      a.textContent = match[0];
      el.appendChild(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }

  function add(role, text) {
    var li = document.createElement('li');
    li.className = 'chat__msg chat__msg--' + role;
    fill(li, role === 'bot' ? clean(text) : text);
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
    return li;
  }

  function render() {
    log.textContent = '';
    add('bot', GREETING);
    for (var i = 0; i < state.messages.length; i++) {
      add(state.messages[i].role, state.messages[i].text);
    }
    suggest.hidden = state.messages.length > 0;
  }

  function busy(on) {
    sending = on;
    send.disabled = on;
    var chips = suggest.querySelectorAll('button');
    for (var i = 0; i < chips.length; i++) chips[i].disabled = on;
  }

  /* תיבת הכתיבה גדלה עם הטקסט, עד ארבע שורות */
  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  }

  /* ---------- פתיחה וסגירה ---------- */

  /* בנייד החלון ממלא את המסך. בספארי המקלדת מכסה את תחתית המסך בלי
     לשנות את גודל החלון, ותיבת הכתיבה נעלמת מאחוריה. visualViewport
     יודע כמה מהמסך באמת נראה, ולכן החלון מתאים את עצמו אליו. */
  var small = window.matchMedia('(max-width: 39.99rem)');

  function fit() {
    var vv = window.visualViewport;
    if (!vv || panel.hidden || !small.matches) {
      panel.style.top = panel.style.bottom = panel.style.height = '';
      return;
    }
    panel.style.top = vv.offsetTop + 'px';
    panel.style.bottom = 'auto';
    panel.style.height = vv.height + 'px';
    log.scrollTop = log.scrollHeight;
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }

  function open() {
    panel.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('chat-is-open');
    fit();
    log.scrollTop = log.scrollHeight;
    input.focus();
  }

  function close() {
    panel.hidden = true;
    fit();
    openBtn.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('chat-is-open');
    openBtn.focus();
  }

  /* ---------- שליחה ---------- */

  function ask(text) {
    text = String(text || '').trim();
    if (!text || sending) return;
    if (text.length > MAX_CHARS) {
      add('note', ERRORS.too_long);
      return;
    }

    state.messages.push({ role: 'user', text: text });
    save();
    add('user', text);
    suggest.hidden = true;
    input.value = '';
    grow();

    var pending = add('pending', PENDING);
    busy(true);

    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);

    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: text }),
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; });
      })
      .then(function (data) {
        if (data && data.ok === true && typeof data.reply === 'string' && data.reply.trim()) {
          state.messages.push({ role: 'bot', text: data.reply });
          save();
          finish(pending);
          add('bot', data.reply);
        } else {
          fail(pending, text, data && data.reason);
        }
      })
      .catch(function () {
        fail(pending, text, null);
      })
      .then(function () {
        clearTimeout(timer);
      });
  }

  function finish(pending) {
    if (pending.parentNode) pending.parentNode.removeChild(pending);
    busy(false);
  }

  /* השאלה חוזרת לתיבה, כדי שניסיון חוזר לא ידרוש להקליד מחדש.
     ההודעה על התקלה אינה נשמרת: אחרי רענון היא כבר לא נכונה. */
  function fail(pending, text, reason) {
    finish(pending);
    state.messages.pop();
    save();
    if (log.lastChild && log.lastChild.className === 'chat__msg chat__msg--user') {
      log.removeChild(log.lastChild);
    }
    add('note', ERRORS[reason] || ERRORS.generic);
    if (!input.value) {
      input.value = text;
      grow();
    }
    suggest.hidden = state.messages.length > 0;
    input.focus();
  }

  /* ---------- אירועים ---------- */

  openBtn.addEventListener('click', function () {
    if (panel.hidden) open(); else close();
  });
  closeBtn.addEventListener('click', close);

  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    ask(input.value);
  });

  /* Enter שולח, Shift+Enter יורד שורה. בזמן הרכבת טקסט במקלדת
     (isComposing) Enter שייך למקלדת ולא לנו. */
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input.value);
    }
  });
  input.addEventListener('input', grow);

  suggest.addEventListener('click', function (e) {
    var chip = e.target.closest('button');
    if (chip) ask(chip.textContent);
  });

  input.maxLength = MAX_CHARS;
  render();
})();
