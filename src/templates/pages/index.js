const fs = require('fs');
const path = require('path');

const PAGES_DIR = __dirname;

// Cache loaded templates
const cache = {};

// Load a page template and substitute variables
function render(templateName, vars = {}) {
  // Load template (with caching)
  if (!cache[templateName]) {
    const templatePath = path.join(PAGES_DIR, `${templateName}.html`);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templateName}`);
    }
    cache[templateName] = fs.readFileSync(templatePath, 'utf-8');
  }

  let html = cache[templateName];

  // Substitute variables: {{varName}} -> value
  for (const [key, value] of Object.entries(vars)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return html;
}

// Render OAuth result page
function oauthResult(status, title, message) {
  const isSuccess = status === 'success';
  const color = isSuccess ? '#22c55e' : '#ef4444';
  const bgColor = isSuccess ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';
  const icon = isSuccess
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

  return render('oauth-result', { title, message, color, bgColor, icon });
}

// Render home page
function home() {
  return render('home');
}

// Render 404 page
function notFound() {
  return render('404');
}

// Render call page
function call(vars) {
  return render('call', vars);
}

module.exports = {
  render,
  oauthResult,
  home,
  notFound,
  call
};
