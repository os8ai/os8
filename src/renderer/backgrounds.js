/**
 * Background/wallpaper management for OS8
 */

// State
let currentBackground = 'gradient-purple';
let currentScrim = 25;

// Background definitions
export const gradientBackgrounds = [
  {
    id: 'gradient-purple',
    name: 'Purple Nebula',
    type: 'gradient',
    css: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)',
  },
  {
    id: 'gradient-blue',
    name: 'Ocean Blue',
    type: 'gradient',
    css: 'linear-gradient(135deg, #0f172a 0%, #0c4a6e 50%, #0f172a 100%)',
  },
  {
    id: 'gradient-emerald',
    name: 'Emerald',
    type: 'gradient',
    css: 'linear-gradient(135deg, #0f172a 0%, #064e3b 50%, #0f172a 100%)',
  },
  {
    id: 'gradient-sunset',
    name: 'Sunset',
    type: 'gradient',
    css: 'linear-gradient(135deg, #0f172a 0%, #7c2d12 30%, #581c87 70%, #0f172a 100%)',
  },
  {
    id: 'gradient-midnight',
    name: 'Midnight',
    type: 'gradient',
    css: 'linear-gradient(135deg, #020617 0%, #0f172a 50%, #020617 100%)',
  },
  {
    id: 'gradient-rose',
    name: 'Rose',
    type: 'gradient',
    css: 'linear-gradient(135deg, #0f172a 0%, #4c0519 50%, #0f172a 100%)',
  },
];

export const os8Backgrounds = [
  {
    id: 'os8-mythic',
    name: 'Mythic',
    type: 'image',
    url: './backgrounds/OS8-mythic.png',
    thumbnail: './backgrounds/OS8-mythic.png',
  },
  {
    id: 'os8-solar-array',
    name: 'Solar Array',
    type: 'image',
    url: './backgrounds/OS8-solar-array.png',
    thumbnail: './backgrounds/OS8-solar-array.png',
  },
  {
    id: 'os8-neon-forest',
    name: 'Neon Forest',
    type: 'image',
    url: './backgrounds/OS8-neon-forest.png',
    thumbnail: './backgrounds/OS8-neon-forest.png',
  },
  {
    id: 'os8-steampunk-engine',
    name: 'Steampunk',
    type: 'image',
    url: './backgrounds/OS8-steampunk-engine.png',
    thumbnail: './backgrounds/OS8-steampunk-engine.png',
  },
  {
    id: 'os8-frozen-titan',
    name: 'Frozen Titan',
    type: 'image',
    url: './backgrounds/OS8-frozen-titan.png',
    thumbnail: './backgrounds/OS8-frozen-titan.png',
  },
  {
    id: 'os8-mirage',
    name: 'Mirage',
    type: 'image',
    url: './backgrounds/OS8-mirage.png',
    thumbnail: './backgrounds/OS8-mirage.png',
  },
  {
    id: 'os8-cosmos',
    name: 'Cosmos',
    type: 'image',
    url: './backgrounds/OS8-cosmos.png',
    thumbnail: './backgrounds/OS8-cosmos.png',
  },
  {
    id: 'os8-deep-sea',
    name: 'Deep Sea',
    type: 'image',
    url: './backgrounds/OS8-deep-sea.png',
    thumbnail: './backgrounds/OS8-deep-sea.png',
  },
  {
    id: 'os8-mount',
    name: 'Monument',
    type: 'image',
    url: './backgrounds/OS8-mount.png',
    thumbnail: './backgrounds/OS8-mount.png',
  },
];

export const landscapeBackgrounds = [
  {
    id: 'img-mountains',
    name: 'Mountains',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400&q=60',
  },
  {
    id: 'img-aurora',
    name: 'Aurora',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=1920&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=400&q=60',
  },
  {
    id: 'img-ocean',
    name: 'Ocean',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1505142468610-359e7d316be0?w=1920&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1505142468610-359e7d316be0?w=400&q=60',
  },
  {
    id: 'img-forest',
    name: 'Forest',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=400&q=60',
  },
  {
    id: 'img-stars',
    name: 'Stars',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=1920&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=400&q=60',
  },
  {
    id: 'img-desert',
    name: 'Desert',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=1920&q=80',
    thumbnail: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=400&q=60',
  },
];

export const allBackgrounds = [...gradientBackgrounds, ...os8Backgrounds, ...landscapeBackgrounds];

export function getBackgroundById(id) {
  return allBackgrounds.find(bg => bg.id === id) || gradientBackgrounds[0];
}

export function applyBackground(bgId) {
  const bg = getBackgroundById(bgId);
  const gradientEl = document.getElementById('homeBgGradient');
  const imageEl = document.getElementById('homeBgImage');

  if (bg.type === 'gradient') {
    gradientEl.style.background = bg.css;
    imageEl.style.backgroundImage = '';
    imageEl.classList.remove('loaded');
  } else if (bg.type === 'image') {
    gradientEl.style.background = '#0f172a';

    // Preload image then apply
    const img = new Image();
    img.onload = () => {
      imageEl.style.backgroundImage = `url(${bg.url})`;
      imageEl.classList.add('loaded');
    };
    img.src = bg.url;
  }

  currentBackground = bgId;
}

export function applyScrim(value) {
  const overlayEl = document.getElementById('homeBgOverlay');
  overlayEl.style.background = `rgba(15, 23, 42, ${value / 100})`;
  currentScrim = value;
}

export function getCurrentBackground() {
  return currentBackground;
}

export function getCurrentScrim() {
  return currentScrim;
}

export function renderBackgroundPicker(selectedId) {
  const picker = document.getElementById('backgroundPicker');

  let html = `
    <div class="background-section-title">Gradients</div>
    <div class="background-grid">
      ${gradientBackgrounds.map(bg => `
        <div class="background-option ${bg.id === selectedId ? 'selected' : ''}" data-bg-id="${bg.id}">
          <div class="background-option-preview gradient" style="background: ${bg.css}"></div>
          <div class="background-option-name">${bg.name}</div>
          <div class="background-option-check">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="background-section-title">OS8 Images</div>
    <div class="background-grid">
      ${os8Backgrounds.map(bg => `
        <div class="background-option ${bg.id === selectedId ? 'selected' : ''}" data-bg-id="${bg.id}">
          <div class="background-option-preview image" style="background-image: url(${bg.thumbnail})"></div>
          <div class="background-option-name">${bg.name}</div>
          <div class="background-option-check">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="background-section-title">Landscape Images</div>
    <div class="background-grid">
      ${landscapeBackgrounds.map(bg => `
        <div class="background-option ${bg.id === selectedId ? 'selected' : ''}" data-bg-id="${bg.id}">
          <div class="background-option-preview image" style="background-image: url(${bg.thumbnail})"></div>
          <div class="background-option-name">${bg.name}</div>
          <div class="background-option-check">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  picker.innerHTML = html;

  // Add click handlers
  picker.querySelectorAll('.background-option').forEach(option => {
    option.addEventListener('click', () => {
      const bgId = option.dataset.bgId;

      // Update selection UI
      picker.querySelectorAll('.background-option').forEach(opt => opt.classList.remove('selected'));
      option.classList.add('selected');

      // Apply background immediately (preview)
      applyBackground(bgId);
    });
  });
}

export async function loadBackgroundSetting() {
  const saved = await window.os8.settings.get('homeBackground');
  if (saved) {
    currentBackground = saved;
  }
  applyBackground(currentBackground);

  const savedScrim = await window.os8.settings.get('homeScrim');
  if (savedScrim !== null) {
    currentScrim = parseInt(savedScrim, 10);
  }
  applyScrim(currentScrim);
}

export async function saveBackgroundSetting() {
  await window.os8.settings.set('homeBackground', currentBackground);
  await window.os8.settings.set('homeScrim', String(currentScrim));
}
