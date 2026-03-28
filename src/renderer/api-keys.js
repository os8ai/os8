/**
 * API Keys management for OS8
 * Handles storage and retrieval of API keys for AI services
 * Key metadata is fetched from the api_key_catalog table via /api/ai/api-keys
 */

// Cached catalog keys (populated on first load)
let cachedCatalogKeys = [];

/**
 * Render predefined API key groups
 * @param {Array} envVars - Current environment variables from database
 * @param {Array} predefinedKeys - Key definitions from api_key_catalog
 */
function renderPredefinedKeys(envVars, predefinedKeys) {
  const container = document.getElementById('apiKeysList');

  container.innerHTML = predefinedKeys.map(keyConfig => {
    const envVar = envVars.find(v => v.key === keyConfig.key);
    const hasValue = envVar && envVar.value;

    return `
      <div class="api-key-group" data-key="${keyConfig.key}">
        <div class="api-key-header">
          <label class="api-key-label">${keyConfig.label}</label>
          <span class="api-key-env">${keyConfig.key}</span>
        </div>
        <a href="${keyConfig.link}" target="_blank" class="api-key-link">${keyConfig.linkText}</a>
        <p class="api-key-description">${keyConfig.description}</p>
        <div class="api-key-input-row">
          <input type="password" class="api-key-input" placeholder="${keyConfig.placeholder}" autocomplete="off"
                 value="${hasValue ? envVar.value : ''}" data-original-value="${hasValue ? envVar.value : ''}">
          <button class="api-key-toggle" title="Show/hide key">
            <svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
          <button class="api-key-save ${hasValue ? 'saved' : ''}" ${hasValue ? 'disabled' : ''}>${hasValue ? 'Saved' : 'Save'}</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach event listeners to rendered elements
  container.querySelectorAll('.api-key-group').forEach(group => {
    const keyName = group.dataset.key;
    const keyConfig = predefinedKeys.find(k => k.key === keyName);
    const input = group.querySelector('.api-key-input');
    const saveBtn = group.querySelector('.api-key-save');
    const toggleBtn = group.querySelector('.api-key-toggle');

    // Track changes
    input.addEventListener('input', () => {
      const changed = input.value !== (input.dataset.originalValue || '');
      saveBtn.disabled = !changed && !input.value;
      saveBtn.textContent = 'Save';
      saveBtn.classList.remove('saved');
    });

    // Save key
    saveBtn.addEventListener('click', async () => {
      await window.os8.env.set(keyName, input.value, keyConfig.description);
      input.dataset.originalValue = input.value;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saved';
      saveBtn.classList.add('saved');
    });

    // Toggle visibility
    toggleBtn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });
}

/**
 * Render custom environment variables list
 * @param {Array} customKeys - Custom environment variables
 */
function renderCustomKeys(customKeys) {
  const container = document.getElementById('customKeysList');

  container.innerHTML = customKeys.map(envVar => `
    <div class="custom-key-row" data-key="${envVar.key}">
      <div class="custom-key-name">
        <input type="text" class="custom-key-name-input" value="${envVar.key}" readonly>
      </div>
      <div class="custom-key-value">
        <input type="password" class="custom-key-value-input" value="${envVar.value || ''}"
               data-original-value="${envVar.value || ''}" autocomplete="off">
        <button class="api-key-toggle" title="Show/hide">
          <svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button class="custom-key-save" disabled>Save</button>
        <button class="custom-key-delete" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');

  // Attach event listeners to rendered elements
  container.querySelectorAll('.custom-key-row').forEach(row => {
    const keyName = row.dataset.key;
    const envVar = customKeys.find(v => v.key === keyName);
    const valueInput = row.querySelector('.custom-key-value-input');
    const saveBtn = row.querySelector('.custom-key-save');
    const deleteBtn = row.querySelector('.custom-key-delete');
    const toggleBtn = row.querySelector('.api-key-toggle');

    valueInput.addEventListener('input', () => {
      const changed = valueInput.value !== valueInput.dataset.originalValue;
      saveBtn.disabled = !changed;
      saveBtn.textContent = 'Save';
      saveBtn.classList.remove('saved');
    });

    saveBtn.addEventListener('click', async () => {
      await window.os8.env.set(keyName, valueInput.value, envVar?.description);
      valueInput.dataset.originalValue = valueInput.value;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saved';
      saveBtn.classList.add('saved');
    });

    deleteBtn.addEventListener('click', async () => {
      if (confirm(`Delete ${keyName}?`)) {
        await window.os8.env.delete(keyName);
        row.remove();
      }
    });

    toggleBtn.addEventListener('click', () => {
      valueInput.type = valueInput.type === 'password' ? 'text' : 'password';
    });
  });
}

/**
 * Load and render all API keys from the database
 */
export async function loadApiKeys() {
  // Fetch catalog key definitions from DB
  let predefinedKeys = cachedCatalogKeys;
  if (predefinedKeys.length === 0) {
    try {
      const port = await window.os8.server.getPort();
      const res = await fetch(`http://localhost:${port}/api/ai/api-keys`);
      predefinedKeys = await res.json();
      cachedCatalogKeys = predefinedKeys;
    } catch (e) {
      console.warn('Failed to fetch API key catalog:', e.message);
      predefinedKeys = [];
    }
  }

  const predefinedKeyNames = predefinedKeys.map(k => k.key);
  const allEnvVars = await window.os8.env.list();

  // Render predefined keys
  renderPredefinedKeys(allEnvVars, predefinedKeys);

  // Render custom keys (those not in predefined list)
  const customKeys = allEnvVars.filter(v => !predefinedKeyNames.includes(v.key));
  renderCustomKeys(customKeys);
}

/**
 * Initialize API keys event listeners (for static elements only)
 */
export function initApiKeysListeners() {
  // Add custom key button (this is static HTML)
  const addBtn = document.getElementById('addCustomKeyBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      showAddCustomKeyDialog();
    });
  }
}

/**
 * Show dialog to add a custom environment variable
 */
function showAddCustomKeyDialog() {
  const keyName = prompt('Enter variable name (e.g., MY_API_KEY):');
  if (!keyName) return;

  // Validate key name (uppercase letters, numbers, underscores)
  const validName = keyName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (validName !== keyName.toUpperCase()) {
    alert(`Variable name adjusted to: ${validName}`);
  }

  // Check if already exists in catalog
  const predefinedKeyNames = cachedCatalogKeys.map(k => k.key);
  if (predefinedKeyNames.includes(validName)) {
    alert('This is a pre-defined key. Use the field above instead.');
    return;
  }

  // Check if custom key already exists
  const existingRow = document.querySelector(`.custom-key-row[data-key="${validName}"]`);
  if (existingRow) {
    alert('This variable already exists.');
    existingRow.querySelector('.custom-key-value-input')?.focus();
    return;
  }

  // Add the new key row
  addCustomKeyRow(validName, '');
}

/**
 * Add a new custom key row (for newly created keys)
 */
function addCustomKeyRow(keyName, value) {
  const container = document.getElementById('customKeysList');

  const row = document.createElement('div');
  row.className = 'custom-key-row';
  row.dataset.key = keyName;
  row.innerHTML = `
    <div class="custom-key-name">
      <input type="text" class="custom-key-name-input" value="${keyName}" readonly>
    </div>
    <div class="custom-key-value">
      <input type="password" class="custom-key-value-input" value="${value}" placeholder="Enter value..."
             data-original-value="${value}" autocomplete="off">
      <button class="api-key-toggle" title="Show/hide">
        <svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <button class="custom-key-save">Save</button>
      <button class="custom-key-delete" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
  `;
  container.appendChild(row);

  const valueInput = row.querySelector('.custom-key-value-input');
  const saveBtn = row.querySelector('.custom-key-save');
  const deleteBtn = row.querySelector('.custom-key-delete');
  const toggleBtn = row.querySelector('.api-key-toggle');

  valueInput.addEventListener('input', () => {
    const changed = valueInput.value !== valueInput.dataset.originalValue;
    saveBtn.disabled = !changed && !valueInput.value;
    saveBtn.textContent = 'Save';
    saveBtn.classList.remove('saved');
  });

  saveBtn.addEventListener('click', async () => {
    await window.os8.env.set(keyName, valueInput.value, `Custom variable: ${keyName}`);
    valueInput.dataset.originalValue = valueInput.value;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saved';
    saveBtn.classList.add('saved');
  });

  deleteBtn.addEventListener('click', async () => {
    if (confirm(`Delete ${keyName}?`)) {
      await window.os8.env.delete(keyName);
      row.remove();
    }
  });

  toggleBtn.addEventListener('click', () => {
    valueInput.type = valueInput.type === 'password' ? 'text' : 'password';
  });

  // Focus the input
  valueInput.focus();
}
