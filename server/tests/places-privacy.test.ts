import { afterEach, expect, it, vi } from 'vitest';
import { details, suggest } from '../src/places.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
for (const operation of ['suggest', 'details'] as const) {
  for (const failure of ['response', 'transport'] as const) {
    it(`${operation} keeps provider ${failure} diagnostics free of echoed applicant data`, async () => {
      vi.stubEnv('GOOGLE_PLACES_API_KEY', 'synthetic-provider-key');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const privateEcho = 'synthetic-provider-key private-address private-session';
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (failure === 'transport') throw new Error(privateEcho);
        return new Response(privateEcho, { status: 429 });
      }));
      const result = operation === 'suggest'
        ? await suggest('private-address', 'CA', 'private-session')
        : await details('private-place', 'private-session');
      expect(result).toEqual(operation === 'suggest' ? [] : null);
      expect(log).toHaveBeenCalledTimes(1);
      const diagnostic = log.mock.calls.flat().join(' ');
      expect(diagnostic).toMatch(/^\[places\]/);
      if (failure === 'response') expect(diagnostic).toContain('429');
      for (const token of privateEcho.split(' ')) expect(diagnostic).not.toContain(token);
    });
  }
}
