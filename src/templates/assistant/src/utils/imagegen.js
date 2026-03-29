/**
 * Shared image generation utilities for agent portrait creation.
 * Used by SetupScreen (new agent flow) and ImageRegenModal (regeneration).
 */

/**
 * Build appearance description string from structured fields.
 */
export function buildAppearanceDesc({ age, hairColor, skinTone, height, build, otherFeatures }) {
  const parts = []
  if (age) parts.push(`${age} years old`)
  if (hairColor) parts.push(`${hairColor} hair`)
  if (skinTone) parts.push(`${skinTone} skin tone`)
  if (height) parts.push(`${height} height`)
  if (build) parts.push(`${build} build`)
  if (otherFeatures?.trim()) parts.push(otherFeatures.trim())
  return parts.join(', ')
}

/**
 * Build a headshot generation prompt from appearance fields.
 */
export function buildHeadshotPrompt({ gender, age, hairColor, skinTone, height, build, otherFeatures, role }) {
  const appearanceDesc = buildAppearanceDesc({ age, hairColor, skinTone, height, build, otherFeatures })
  const genderWord = gender === 'male' ? 'male' : 'female'
  const rolePart = role ? ` Their role: ${role}.` : ''
  return `Portrait headshot of a ${genderWord} person. ${appearanceDesc}.${rolePart} Clean background, photorealistic, professional lighting.`
}

/**
 * Build a body reference generation prompt.
 */
export function buildBodyPrompt({ gender, height, build }) {
  const genderWord = gender === 'male' ? 'male' : 'female'
  const bodyDesc = [height ? `${height} height` : '', build ? `${build} build` : ''].filter(Boolean).join(', ')
  return `Full body photo of a ${genderWord} person${bodyDesc ? ` with ${bodyDesc}` : ''}. Wearing a simple form-fitting outfit (plain t-shirt and fitted pants). Standing in a neutral pose, clean white background, photorealistic, full body visible head to toe.`
}

/**
 * Build provider assignments: 2 per available provider, min minCount total.
 */
export function buildAssignments(imagegenProviders, priorityOrder, minCount = 4) {
  const available = priorityOrder.filter(p => imagegenProviders?.[p]?.available)
  if (available.length === 0) return []
  const assignments = available.flatMap(p => [p, p])
  while (assignments.length < minCount) assignments.push(available[0])
  return assignments
}

/**
 * Fire parallel image generation requests. Calls onImageReady(index, result) as each completes.
 * Returns Promise that resolves when all are done.
 */
export async function generateParallel({ baseApiUrl, prompt, assignments, referenceImages, signal, onImageReady }) {
  const promises = assignments.map((provider, i) =>
    fetch(`${baseApiUrl}/api/imagegen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        provider,
        ...(referenceImages ? { referenceImages } : {}),
        options: { size: '1024x1024', quality: 'medium' }
      }),
      signal
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        if (signal?.aborted) return
        const img = data.success && data.images?.[0]
        onImageReady(i, img
          ? { url: data.images[0].url, filename: data.images[0].filename, loading: false }
          : { error: true, loading: false })
      })
      .catch(err => {
        if (err.name === 'AbortError' || signal?.aborted) return
        onImageReady(i, { error: true, loading: false })
      })
  )
  await Promise.allSettled(promises)
}

/**
 * Fetch an image as base64 for use as a reference image.
 */
export async function fetchImageAsBase64(url) {
  const res = await fetch(url)
  const blob = await res.blob()
  const base64 = await new Promise(resolve => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result.split(',')[1])
    reader.readAsDataURL(blob)
  })
  return { data: base64, mimeType: blob.type || 'image/png' }
}
