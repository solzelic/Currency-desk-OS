import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Focused real staging seam; supply a fresh disposable SEAM_DATABASE_URL.
if (!process.env.SEAM_DATABASE_URL) throw new Error('A disposable SEAM_DATABASE_URL is required');
const host = 'staging.currencydeskos.com';
export default defineConfig({
  ...base, testDir: './tests/staging-signin', outputDir: 'test-results/staging-signin', retries: 0,
  webServer: { ...base.webServer as object, reuseExistingServer: false,
    env: { ...(base.webServer as { env: Record<string, string> }).env,
      STAGING: '1', RENDER_EXTERNAL_HOSTNAME: host, IS_PULL_REQUEST: '',
      CD_TEST_BREACH_RANGE: 'local-staging',
      RESEND_API_KEY: '', EMAIL_FROM: '', STRIPE_SECRET_KEY: '' } },
  use: { ...base.use, baseURL: `http://${host}:4173`, trace: 'off',
    launchOptions: { ...base.use?.launchOptions, args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`] } },
});
