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

  var CLOSED_MSG = 'אנחנו מקבלים הזמנות בין 07:00 ל־20:00. הטופס ייפתח שוב ב־07:00 בבוקר.';
  var MIN_MSG = 'אנחנו מקבלים הזמנות עד 20:00 בערב, ומינימום 40 ש״ח למשלוח.';
  var CHALLAH_MSG = 'חלה נאפית לשישי בלבד. אפשר להזמין אותה רק ביום חמישי, למשלוח בשישי בבוקר.';
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
          '. המשלוח ' + (data.delivery_date || 'מחר בבוקר') + ', בין 07:00 ל־09:00, ' +
          'ולתשלום במסירה ' + (data.total != null ? data.total : total) + ' ₪.',
          'ok'
        );
      })
      .catch(function () {
        say('משהו השתבש בשליחה. אפשר לנסות שוב, או להתקשר אלינו ל-04-1234567.', 'error');
      })
      .then(function () {
        sending = false;
        lockedByClock = isClosed();
        button.disabled = lockedByClock;
        if (lockedByClock) say(CLOSED_MSG);
      });
  });
})();
