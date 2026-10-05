/* תפריט העמודים הפנימיים.

   הרשימה כאן היא המקום היחיד שבו מוגדרים העמודים. עמוד חדש מתווסף
   בשורה אחת ב-PAGES, וכל עמוד שטוען את הקובץ הזה מקבל אותו בתפריט.

   הקובץ יושב בתיקייה הסודית ולא ב-/assets, כי הוא מכיל את הכתובות של
   כל העמודים הפנימיים. בתיקייה ציבורית, כל מי שהיה פותח אותו היה רואה
   את כולן. */
(function () {
  'use strict';

  var PAGES = [
    { file: 'index.html',     label: 'קליטת חשבוניות' },
    { file: 'documents.html', label: 'מסמכי הבוט' }
  ];

  var list = document.querySelector('#adminnav .adminnav__list');
  if (!list) return;

  /* בכתובת התיקייה עצמה, עם לוכסן או בלעדיו, מוגש index.html. מנרמלים
     גם .html כדי שהעמוד הנוכחי יזוהה אם Vercel יגיש כתובות בלי סיומת. */
  function key(name) {
    name = (name || '').replace(/\.html$/, '');
    return name === '' || name.indexOf('invoices-') === 0 ? 'index' : name;
  }
  var here = key(location.pathname.split('/').pop());

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
})();
