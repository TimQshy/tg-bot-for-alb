// Shared by every page of the site, loaded with `defer`. Contacts and the
// GA4 ID are filled in here once and apply everywhere.
window.SITE = {
  whatsapp: '996707160409',      // number for wa.me, digits only: 996700123456
  telegram: 'TELEGRAM_USERNAME', // Telegram username without @
  ga: 'G-XXXXXXXXXX',            // GA4 measurement ID
  demo: '',                      // optional: a demo salon's bot people can book with themselves, https://t.me/... or https://wa.me/...
};

(function () {
  'use strict';
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // ── Analytics ───────────────────────────────────────────
  // GA4 loads only on the real domain and only once an ID is set, so local
  // previews and the placeholder never pollute the stats.
  window.gtag = function () {};
  var id = SITE.ga;
  if (/^G-[A-Z0-9]+$/.test(id) && !/^G-X+$/.test(id) && /(^|\.)zapisbot\.online$/.test(location.hostname)) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', id);
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
    document.head.appendChild(s);
  }
  function track(name, params) { try { gtag('event', name, params || {}); } catch (e) {} }
  window.track = track;

  // ── Contact links ───────────────────────────────────────
  // Placeholders keep pointing at the contact section until real values are
  // set above, so a half-configured page never links to a stranger. Each
  // WhatsApp button carries its own opening line (data-wa), which tells us
  // in the chat which page and button the person came from.
  var waSet = /^\d{10,15}$/.test(SITE.whatsapp);
  var tgSet = /^[A-Za-z0-9_]{5,32}$/.test(SITE.telegram) && SITE.telegram !== 'TELEGRAM_USERNAME';
  var demoSet = /^https:\/\/(t\.me|wa\.me)\/\S+$/.test(SITE.demo);
  function external(a, href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }

  $$('[data-wa]').forEach(function (a) {
    if (waSet) external(a, 'https://wa.me/' + SITE.whatsapp + '?text=' + encodeURIComponent(a.dataset.wa));
    a.addEventListener('click', function () { track('contact_click', { channel: 'whatsapp', place: a.dataset.place }); });
  });
  // Without a username a Telegram button has nowhere to go, so it is removed.
  $$('[data-tg]').forEach(function (a) {
    if (!tgSet) { a.remove(); return; }
    external(a, 'https://t.me/' + SITE.telegram);
    a.addEventListener('click', function () { track('contact_click', { channel: 'telegram', place: a.dataset.place }); });
  });
  // Hidden in the markup: without a demo bot there is nothing to show.
  $$('[data-demo]').forEach(function (a) {
    if (!demoSet) return;
    external(a, SITE.demo);
    a.hidden = false;
    a.addEventListener('click', function () { track('demo_click', { place: a.dataset.place }); });
  });

  if (waSet) {
    var n = SITE.whatsapp;
    var phone = n.length === 12 ? '+' + n.slice(0, 3) + ' ' + n.slice(3, 6) + ' ' + n.slice(6, 9) + ' ' + n.slice(9) : '+' + n;
    $$('[data-wa-label]').forEach(function (el) { el.textContent = phone; });
  }
  if (tgSet) $$('[data-tg-label]').forEach(function (el) { el.textContent = '@' + SITE.telegram; });

  // ── Dates in chat examples ──────────────────────────────
  // A fixed date in an example goes stale within a day; data-day="2" reads
  // as the day after tomorrow, in the bot's own format.
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  $$('[data-day]').forEach(function (el) {
    var d = new Date();
    d.setDate(d.getDate() + Number(el.dataset.day));
    el.textContent = d.getDate() + ' ' + MONTHS[d.getMonth()] + ' (' + DAYS[d.getDay()] + ')';
  });

  // ── FAQ ─────────────────────────────────────────────────
  // The structured data is built from the questions on the page itself, so
  // it can never drift from what visitors read.
  var faq = $$('.faq details');
  faq.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) track('faq_open', { question: d.querySelector('summary').textContent.trim() });
    });
  });
  if (faq.length) {
    var ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(function (d) {
        var answer = Array.prototype.map.call(d.querySelectorAll('.ans p'), function (p) { return p.textContent.trim(); }).join(' ');
        return {
          '@type': 'Question',
          name: d.querySelector('summary').textContent.trim(),
          acceptedAnswer: { '@type': 'Answer', text: answer },
        };
      }),
    });
    document.head.appendChild(ld);
  }
})();
