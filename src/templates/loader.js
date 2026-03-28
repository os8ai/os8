const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = __dirname;

/**
 * Load a template file and substitute variables.
 * Variables use {{VARIABLE_NAME}} syntax.
 *
 * @param {string} templatePath - Path relative to templates directory (e.g., 'base/index.html')
 * @param {Object} variables - Key-value pairs to substitute
 * @returns {string} - Template content with variables substituted
 */
function loadTemplate(templatePath, variables = {}) {
  const fullPath = path.join(TEMPLATES_DIR, templatePath);
  let content = fs.readFileSync(fullPath, 'utf-8');

  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    content = content.replace(regex, value);
  }

  return content;
}

/**
 * Scaffold an app from templates.
 * Copies base templates first, then template-specific files.
 *
 * @param {string} appPath - Destination path for the app
 * @param {string} templateName - Template to use ('standard', 'assistant', etc.)
 * @param {Object} variables - Variables to substitute in templates
 */
function scaffoldFromTemplate(appPath, templateName, variables) {
  // Ensure src directory exists
  const srcPath = path.join(appPath, 'src');
  fs.mkdirSync(srcPath, { recursive: true });

  // Copy base templates
  copyTemplateFiles('base', appPath, variables);

  // Copy template-specific files (overrides base if same name)
  copyTemplateFiles(templateName, appPath, variables);
}

/**
 * Copy all files from a template directory to the app.
 * Handles nested directories (like src/).
 */
function copyTemplateFiles(templateName, appPath, variables) {
  const templateDir = path.join(TEMPLATES_DIR, templateName);

  if (!fs.existsSync(templateDir)) {
    throw new Error(`Template '${templateName}' not found at ${templateDir}`);
  }

  copyDirRecursive(templateDir, appPath, variables);
}

/**
 * Recursively copy a directory, applying variable substitution to file contents.
 */
function copyDirRecursive(srcDir, destDir, variables) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath, variables);
    } else {
      // Read, substitute, write
      let content = fs.readFileSync(srcPath, 'utf-8');

      for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        content = content.replace(regex, value);
      }

      fs.writeFileSync(destPath, content);
    }
  }
}

/**
 * List available templates.
 */
function listTemplates() {
  const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && e.name !== 'base')
    .map(e => e.name);
}

module.exports = {
  loadTemplate,
  scaffoldFromTemplate,
  copyTemplateFiles,
  listTemplates,
  TEMPLATES_DIR
};
