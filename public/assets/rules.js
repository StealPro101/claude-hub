/* Static pages only need the bar, the footer and a heartbeat so the person counts. */
(function () {
  'use strict';
  Hub.bar(document.title.indexOf('Rules') === 0 ? 'rules' : '', null);
  Hub.footer();
  Hub.data().then(function (d) {
    Hub.bar(document.title.indexOf('Rules') === 0 ? 'rules' : '', d);
    Hub.beat(null);
  }).catch(function () { /* the page still reads fine */ });
}());
