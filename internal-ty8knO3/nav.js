/* תפריט העמודים הפנימיים, והכרטיסים בעמוד השער.

   הרשימה כאן היא המקום היחיד שבו מוגדרים העמודים. עמוד חדש מתווסף
   בשורה אחת ב-PAGES, ומקבל גם לשונית בתפריט של כל העמודים וגם כרטיס
   בשער. השורה הראשונה היא השער עצמו, ולכן אין לו כרטיס.

   הקובץ יושב בתיקייה הסודית ולא ב-/assets, כי הוא מכיל את הכתובות של
   כל העמודים הפנימיים. בתיקייה ציבורית, כל מי שהיה פותח אותו היה רואה
   את כולן. */
(function () {
  'use strict';

  var PAGES = [
    { file: 'index.html',     label: 'ראשי' },
    { file: 'invoices.html',  label: 'קליטת חשבוניות',
      desc: 'מעלים צילום או PDF של חשבוניות, בודקים מה נקרא, והן נשמרות בגיליון ובדרייב.' },
    { file: 'documents.html', label: 'מסמכי הבוט',
      desc: 'מחליפים את המחירון, אזורי המשלוח או המדיניות שהבוט באתר עונה מהם.' }
  ];

  /* בכתובת התיקייה עצמה, עם לוכסן או בלעדיו, מוגש index.html. מנרמלים
     גם .html כדי שהעמוד הנוכחי יזוהה אם Vercel יגיש כתובות בלי סיומת. */
  function key(name) {
    name = (name || '').replace(/\.html$/, '');
    return name === '' || name.indexOf('internal-') === 0 ? 'index' : name;
  }
  var here = key(location.pathname.split('/').pop());

  var list = document.querySelector('#adminnav .adminnav__list');
  if (list) {
    PAGES.forEach(function (page) {
      var a = document.createElement('a');
      a.className = 'adminnav__link';
      a.href = page.file;
      a.textContent = page.label;
      if (key(page.file) === here) a.setAttribute('aria-current', 'page');

      var li = document.createElement('li');
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  /* ---------- השער: כרטיס לכל כלי ---------- */

  var tools = document.getElementById('tools');
  if (!tools) return;

  PAGES.forEach(function (page) {
    if (!page.desc) return;

    var a = document.createElement('a');
    a.className = 'tool';
    a.href = page.file;

    var title = document.createElement('h2');
    title.className = 'tool__title';
    title.textContent = page.label;

    var desc = document.createElement('p');
    desc.className = 'tool__desc';
    desc.textContent = page.desc;

    var go = document.createElement('span');
    go.className = 'tool__go';
    go.setAttribute('aria-hidden', 'true');
    go.textContent = 'כניסה ←';

    a.appendChild(title);
    a.appendChild(desc);
    a.appendChild(go);

    var li = document.createElement('li');
    li.appendChild(a);
    tools.appendChild(li);
  });

  /* לשער אין סקריפט משלו, ולכן את מספר הגרסה בפוטר כותב הקובץ הזה,
     מתוך תגית הסקריפט שלו, כמו שאר העמודים */
  var slot = document.getElementById('build');
  var tag = document.querySelector('script[src*="nav.js"]');
  var m = tag && (tag.getAttribute('src') || '').match(/[?&]v=([^&]+)/);
  if (slot) slot.textContent = 'גרסה ' + (m ? m[1] : 'לא ידועה');
})();
