/* טופס ההזמנה -> וובהוק n8n
   הוובהוק מחזיר {ok, order_id, total, delivery_date} אחרי שההזמנה
   נשמרה בגיליון ושני המיילים יצאו, ולכן הודעת ההצלחה למטה אמינה.

   חלון ההזמנות הוא 07:00 עד 20:00 בלבד. הסגירה בלילה היא בכוונה:
   כל הזמנה מגיעה למחרת בבוקר, ומי שמזמין ב-02:00 לא בהכרח שם לב
   שהמשלוח שלו הוא לא הבוקר הקרוב אלא זה שאחריו. */
(function () {
  'use strict';

  var WEBHOOK = 'https://shanyptr.app.n8n.cloud/webhook/bakery-order';
  var MIN_ORDER = 40;
  var OPEN_HOUR = 7;    /* הטופס נפתח ב-07:00 */
  var CLOSE_HOUR = 20;  /* ונסגר ב-20:00 */

  /* בלימת שליחות אוטומטיות. הכל כאן הוא צד לקוח בלבד, ולכן זו שכבה ראשונה
     ולא הגנה. מי ששולח POST ישיר לוובהוק עוקף את כולה, ולכן הסינון האמיתי
     חייב לשבת גם בוורקפלואו. */
  var HONEYPOT = 'lehem-note';  /* שדה מוסתר שרק בוט ימלא */
  var MIN_FILL_MS = 2500;       /* מילוי טופס אמיתי אורך יותר מזה */
  var COOLDOWN_MS = 60000;      /* המתנה בין שליחה לשליחה */
  var MAX_PER_HOUR = 5;         /* תקרת שליחות מאותו דפדפן בשעה */
  var STORE_KEY = 'lvs-sent';

  var CLOSED_MSG = 'אנחנו מקבלים הזמנות בשעות 07:00 עד 20:00. הטופס ייפתח שוב בשבע בבוקר.';
  var MIN_MSG = 'אנחנו מקבלים הזמנות עד 20:00 בערב, ומינימום 40 ש״ח למשלוח.';
  var CHALLAH_MSG = 'חלה נאפית לשישי בלבד. אפשר להזמין אותה רק ביום חמישי, למשלוח בשישי בבוקר.';
  var SLOW_MSG = 'רק רגע, בדקו שהפרטים נכונים ושלחו שוב.';
  var COOLDOWN_MSG = 'ההזמנה הקודמת נשלחה זה עתה. אם צריך להוסיף משהו, אפשר לשלוח שוב בעוד דקה, או להתקשר אלינו לטלפון 04-1234567.';
  var TOO_MANY_MSG = 'נשלחו כמה הזמנות ברצף מהמכשיר הזה. אם משהו לא נקלט, התקשרו אלינו לטלפון 04-1234567.';
  var GENERIC_ERROR = 'משהו השתבש בשליחה. אפשר לנסות שוב, או להתקשר אלינו לטלפון 04-1234567.';
  var CHALLAH_ORDER_DAY = 4;  /* חמישי — כי המשלוח יוצא למחרת בבוקר, כלומר בשישי */

  /* שם השדה בטופס -> השם שהוובהוק מצפה לו, והמחיר ליחידה */
  var ITEMS = [
    { field: 'q-sourdough', key: 'sourdough_bread', price: 32 },
    { field: 'q-rye',       key: 'rye_bread',       price: 36 },
    { field: 'q-challah',   key: 'challah',         price: 28 },
    { field: 'q-bourekas',  key: 'cheese_bourekas', price: 12 }
  ];

  var form = document.getElementById('order-form');
  var button = document.getElementById('order-submit');
  var status = document.getElementById('order-status');
  if (!form || !button || !status) return;

  var sending = false;
  var loadedAt = Date.now();

  /* היסטוריית השליחות של הדפדפן הזה בשעה האחרונה.
     נכשל בשקט בגלישה פרטית, ואז פשוט אין תקרה מקומית. */
  function sentHistory() {
    try {
      var list = JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      var hourAgo = Date.now() - 3600000;
      return list.filter(function (t) { return typeof t === 'number' && t > hourAgo; });
    } catch (e) { return []; }
  }

  function rememberSend(list) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) { /* אין אחסון */ }
  }

  function say(text, kind) {
    status.textContent = text;
    status.className = 'form__status' + (kind ? ' form__status--' + kind : '');
    status.hidden = false;
  }

  function clearStatus() {
    status.hidden = true;
    status.textContent = '';
    status.className = 'form__status';
  }

  /* השעה בישראל, לא בשעון המכשיר של המזמין */
  function bakeryHour() {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false
      }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') return parseInt(parts[i].value, 10) % 24;
      }
    } catch (e) { /* דפדפן ישן, נופלים לשעון המקומי */ }
    return new Date().getHours();
  }

  /* יום בשבוע בישראל. 0=ראשון … 4=חמישי … 6=שבת */
  function bakeryWeekday() {
    try {
      var name = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Jerusalem', weekday: 'short'
      }).format(new Date());
      var i = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
      if (i !== -1) return i;
    } catch (e) { /* דפדפן ישן, נופלים לשעון המקומי */ }
    return new Date().getDay();
  }

  function isClosed() {
    var h = bakeryHour();
    return h >= CLOSE_HOUR || h < OPEN_HOUR;
  }

  /* נועל או משחרר את הטופס לפי השעה. נקרא בטעינה ואחת לדקה,
     כדי שדף שנשאר פתוח כל הלילה ייפתח לבד ב-07:00 וייסגר לבד ב-20:00. */
  var lockedByClock = null;
  function refreshWindow() {
    if (sending) return;
    var closed = isClosed();
    if (closed === lockedByClock) return;
    lockedByClock = closed;
    button.disabled = closed;
    if (closed) say(CLOSED_MSG);
    else if (status.textContent === CLOSED_MSG) clearStatus();
  }

  refreshWindow();
  setInterval(refreshWindow, 60000);

  function qty(name) {
    var n = parseInt(form.elements[name].value, 10);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sending) return;

    /* בדיקה חוזרת ברגע השליחה, לא מסתמכים רק על מצב הכפתור */
    if (isClosed()) {
      refreshWindow();
      return;
    }

    /* שדה המלכודת מלא, כלומר לא אדם מילא את הטופס */
    if (form.elements[HONEYPOT] && form.elements[HONEYPOT].value !== '') {
      say(GENERIC_ERROR, 'error');
      return;
    }

    /* טופס שנשלח מיד עם טעינת הדף */
    if (Date.now() - loadedAt < MIN_FILL_MS) {
      say(SLOW_MSG);
      return;
    }

    if (!form.reportValidity()) return;

    var payload = {
      name: form.elements.name.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      address: form.elements.address.value.trim()
    };

    var total = 0;
    ITEMS.forEach(function (item) {
      var n = qty(item.field);
      payload[item.key] = n;
      total += n * item.price;
    });

    if (payload.challah > 0 && bakeryWeekday() !== CHALLAH_ORDER_DAY) {
      say(CHALLAH_MSG);
      return;
    }

    if (total < MIN_ORDER) {
      say(MIN_MSG);
      return;
    }

    /* תקרה מקומית: לא יותר מ MAX_PER_HOUR שליחות בשעה, ולא שתיים ברצף מהיר */
    var sent = sentHistory();
    if (sent.length >= MAX_PER_HOUR) {
      say(TOO_MANY_MSG, 'error');
      return;
    }
    if (sent.length && Date.now() - sent[sent.length - 1] < COOLDOWN_MS) {
      say(COOLDOWN_MSG);
      return;
    }
    sent.push(Date.now());
    rememberSend(sent);

    sending = true;
    button.disabled = true;
    say('שולחים את ההזמנה…');

    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error('bad payload');
        form.reset();
        say(
          'ההזמנה נקלטה בהצלחה. שלחנו אישור למייל ' + payload.email +
          '. המשלוח ' + (data.delivery_date || 'מחר בבוקר') + ', בשעות 07:00 עד 09:00, ' +
          'ולתשלום במסירה ' + (data.total != null ? data.total : total) + ' ₪.',
          'ok'
        );
      })
      .catch(function () {
        say(GENERIC_ERROR, 'error');
      })
      .then(function () {
        sending = false;
        lockedByClock = isClosed();
        button.disabled = lockedByClock;
        if (lockedByClock) say(CLOSED_MSG);
      });
  });
})();
