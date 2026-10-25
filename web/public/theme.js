// Saved theme, else light, set before the first paint so the page never flashes.
// A separate file, not inline: the API's Content-Security-Policy allows scripts from 'self' only.
try {
  var t = localStorage.getItem('theme') || 'light';
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#f4f2ee' : '#101010';
} catch (e) {}
