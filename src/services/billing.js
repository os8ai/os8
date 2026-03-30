/**
 * BillingService
 * Checks provider billing status via their APIs.
 * Updates ai_account_status with balance info and plan tier.
 */

const { execSync } = require('child_process');
const RoutingService = require('./routing');

const BillingService = {
  /**
   * Check all providers with billing APIs.
   * Non-blocking — errors are caught and logged.
   * @param {object} db
   */
  async checkAll(db) {
    const EnvService = require('./env');
    const envVars = EnvService.asObject(db);

    const checks = [];

    // Anthropic — requires ANTHROPIC_API_KEY
    if (envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) {
      checks.push(
        this.validateApiKey(db, 'anthropic', envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)
          .catch(e => console.warn('[Billing] Anthropic check failed:', e.message))
      );
    } else {
      RoutingService.updateAccountStatus(db, 'anthropic', { api_status: 'no_key' });
    }

    // OpenAI
    if (envVars.OPENAI_API_KEY || process.env.OPENAI_API_KEY) {
      checks.push(
        this.validateApiKey(db, 'openai', envVars.OPENAI_API_KEY || process.env.OPENAI_API_KEY)
          .catch(e => console.warn('[Billing] OpenAI check failed:', e.message))
      );
    } else {
      RoutingService.updateAccountStatus(db, 'openai', { api_status: 'no_key' });
    }

    // Google
    if (envVars.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY) {
      checks.push(
        this.validateApiKey(db, 'google', envVars.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY)
          .catch(e => console.warn('[Billing] Google check failed:', e.message))
      );
    } else {
      RoutingService.updateAccountStatus(db, 'google', { api_status: 'no_key' });
    }

    // xAI
    if (envVars.XAI_API_KEY || process.env.XAI_API_KEY) {
      checks.push(
        this.validateApiKey(db, 'xai', envVars.XAI_API_KEY || process.env.XAI_API_KEY)
          .catch(e => console.warn('[Billing] xAI check failed:', e.message))
      );
    } else {
      RoutingService.updateAccountStatus(db, 'xai', { api_status: 'no_key' });
    }

    // Detect login status for all providers that support it
    checks.push(
      this.detectAllLogins(db)
        .catch(e => console.warn('[Billing] Login detection failed:', e.message))
    );

    await Promise.all(checks);
    console.log('[Billing] All provider checks complete');
  },

  /**
   * Validate an API key by hitting the provider's validation endpoint.
   * @param {object} db
   * @param {string} providerId
   * @param {string} apiKey
   */
  async validateApiKey(db, providerId, apiKey) {
    if (!apiKey) {
      RoutingService.updateAccountStatus(db, providerId, { api_status: 'no_key' });
      return;
    }

    const AIRegistryService = require('./ai-registry');
    const provider = AIRegistryService.getProvider(db, providerId);
    if (!provider?.validation_url) return;

    const headers = {};
    let url = provider.validation_url;

    switch (provider.validation_auth_style) {
      case 'x-api-key':
        headers['x-api-key'] = apiKey;
        if (provider.validation_headers) {
          try {
            Object.assign(headers, JSON.parse(provider.validation_headers));
          } catch (e) {
            console.warn(`[billing] Failed to parse validation_headers for provider: ${e.message}`);
          }
        }
        break;
      case 'bearer':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      case 'query':
        url += (url.includes('?') ? '&' : '?') + `key=${apiKey}`;
        break;
    }

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      const now = new Date().toISOString();

      if (response.ok) {
        RoutingService.updateAccountStatus(db, providerId, {
          api_status: 'valid',
          last_checked_at: now
        });
      } else if (response.status === 401 || response.status === 403) {
        RoutingService.updateAccountStatus(db, providerId, {
          api_status: 'invalid',
          last_checked_at: now
        });
      } else {
        // Other errors (429, 500, etc.) — key may still be valid
        RoutingService.updateAccountStatus(db, providerId, {
          last_checked_at: now
        });
      }
    } catch (e) {
      // Network error — don't change status
      console.warn(`[Billing] ${providerId} validation error:`, e.message);
    }
  },

  /**
   * Detect login status for all containers that support login.
   * Uses the same logic as /api/backend/auth-status — CLI status command or auth file check.
   * @param {object} db
   */
  async detectAllLogins(db) {
    const AIRegistryService = require('./ai-registry');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const containers = AIRegistryService.getContainers(db);
    for (const container of containers) {
      if (!container.has_login) {
        RoutingService.updateAccountStatus(db, container.provider_id, { login_status: 'not_applicable' });
        continue;
      }

      let loggedIn = false;
      let planTier = null;

      // Method 1: CLI status command (Claude)
      if (container.auth_status_command) {
        try {
          const statusCmd = JSON.parse(container.auth_status_command);
          const statusEnv = { ...process.env };
          delete statusEnv.CLAUDECODE;
          const output = execSync(`${statusCmd.cmd} ${statusCmd.args.join(' ')} 2>&1`, {
            env: statusEnv,
            timeout: 10000,
            encoding: 'utf-8'
          });

          // Try JSON parse first (claude auth status returns JSON)
          try {
            const data = JSON.parse(output.trim());
            loggedIn = !!data.loggedIn;
          } catch (e) {
            // Fall back to text parsing
            if (/logged in/i.test(output)) {
              loggedIn = true;
              if (/max/i.test(output)) planTier = 'max';
              else if (/pro/i.test(output)) planTier = 'pro';
              else if (/team/i.test(output)) planTier = 'team';
              else if (/enterprise/i.test(output)) planTier = 'enterprise';
              else if (/free/i.test(output)) planTier = 'free';
            }
          }
        } catch (e) {
          // CLI not available or timed out
        }
      }

      // Method 2: Auth file check (Gemini, Codex)
      if (!loggedIn && container.auth_file_path) {
        try {
          const authPath = path.join(os.homedir(), container.auth_file_path);
          loggedIn = fs.existsSync(authPath);

          // Proactively refresh Gemini OAuth token if expired
          if (loggedIn && container.provider_id === 'google') {
            try {
              const creds = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
              if (creds.expiry_date && Date.now() > creds.expiry_date - 60000 && creds.refresh_token) {
                const ImageGenService = require('./imagegen');
                await ImageGenService._refreshGeminiToken(authPath, creds);
              }
            } catch (e) {
              console.warn('[Billing] Gemini token refresh:', e.message);
            }
          }
        } catch (e) {
          console.warn(`[billing] Auth file check failed for ${container.auth_file_path}: ${e.message}`);
        }
      }

      const updates = {
        login_status: loggedIn ? 'active' : 'not_configured',
        last_checked_at: new Date().toISOString()
      };
      if (planTier) {
        updates.plan_tier = planTier;
        updates.plan_source = 'detected';
      }
      RoutingService.updateAccountStatus(db, container.provider_id, updates);
      console.log(`[Billing] ${container.id}: login=${updates.login_status}${planTier ? ', plan=' + planTier : ''}`);
    }
  },

  /**
   * Check OpenAI credit balance.
   * @param {object} db
   * @param {string} apiKey
   */
  async checkOpenAI(db, apiKey) {
    if (!apiKey) return;

    try {
      const response = await fetch('https://api.openai.com/v1/dashboard/billing/credit_grants', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000)
      });

      if (response.ok) {
        const data = await response.json();
        const balance = data.total_available || 0;
        RoutingService.updateAccountStatus(db, 'openai', {
          api_balance: balance,
          api_balance_updated_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString()
        });
        console.log(`[Billing] OpenAI balance: $${balance.toFixed(2)}`);
      }
    } catch (e) {
      console.warn('[Billing] OpenAI balance check failed:', e.message);
    }
  }
};

module.exports = BillingService;
