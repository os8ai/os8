/**
 * Shared utility functions for OS8
 */

/**
 * Generate a unique ID using timestamp + random string
 * @returns {string} Unique identifier
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a URL-safe slug from a name
 * @param {string} name - The name to convert
 * @returns {string} URL-safe slug
 */
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = {
  generateId,
  generateSlug
};
